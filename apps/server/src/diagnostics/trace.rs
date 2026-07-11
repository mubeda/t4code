use std::{
    collections::{BTreeMap, HashMap},
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use serde_json::{Map, Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

const DEFAULT_MAX_FILES: usize = 3;
const DEFAULT_MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
const SLOW_SPAN_THRESHOLD_MS: f64 = 1_000.0;
const TOP_LIMIT: usize = 10;
const RECENT_LIMIT: usize = 20;
const MAX_CAUSE_CHARS: usize = 8_192;

#[derive(Clone, Debug)]
pub struct TraceDiagnosticsStore {
    path: Arc<PathBuf>,
    max_files: usize,
    max_file_bytes: u64,
    write_lock: Arc<Mutex<()>>,
}

impl TraceDiagnosticsStore {
    #[must_use]
    pub fn new(path: PathBuf) -> Self {
        Self::with_limits(path, DEFAULT_MAX_FILES, DEFAULT_MAX_FILE_BYTES)
    }

    #[must_use]
    pub fn with_limits(path: PathBuf, max_files: usize, max_file_bytes: u64) -> Self {
        Self {
            path: Arc::new(path),
            max_files,
            max_file_bytes: max_file_bytes.max(1),
            write_lock: Arc::new(Mutex::new(())),
        }
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        self.path.as_path()
    }

    pub fn record_failure(&self, name: &str, error: &Value) -> io::Result<()> {
        let now = OffsetDateTime::now_utc().unix_timestamp_nanos();
        let id = Uuid::new_v4().simple().to_string();
        let cause = redact_sensitive_text(&error_summary(error));
        self.append_record(&json!({
            "type": "native-span",
            "name": non_empty(name, "native.failure"),
            "traceId": id,
            "spanId": Uuid::new_v4().simple().to_string(),
            "startTimeUnixNano": now.to_string(),
            "endTimeUnixNano": now.to_string(),
            "durationMs": 0.0,
            "events": [{
                "name": cause,
                "timeUnixNano": now.to_string(),
                "attributes": { "effect.logLevel": "Error" }
            }],
            "exit": { "_tag": "Failure", "cause": cause }
        }))
    }

    pub fn record_otlp_payload(&self, payload: &Value) -> io::Result<usize> {
        let records = decode_otlp_records(payload);
        for record in &records {
            self.append_record(record)?;
        }
        Ok(records.len())
    }

    #[must_use]
    pub fn read(&self) -> Value {
        aggregate(self.path(), self.max_files)
    }

    fn append_record(&self, record: &Value) -> io::Result<()> {
        let _guard = self
            .write_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut encoded = serde_json::to_vec(record).map_err(io::Error::other)?;
        encoded.push(b'\n');
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let current_size = fs::metadata(self.path()).map_or(0, |metadata| metadata.len());
        if current_size > 0
            && current_size.saturating_add(encoded.len() as u64) > self.max_file_bytes
        {
            rotate(self.path(), self.max_files)?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.path())?;
        file.write_all(&encoded)?;
        file.flush()
    }
}

#[derive(Clone)]
struct SpanOccurrence {
    name: String,
    duration_ms: f64,
    ended_at_ns: i128,
    trace_id: String,
    span_id: String,
}

#[derive(Default)]
struct SpanSummary {
    count: usize,
    failure_count: usize,
    total_duration_ms: f64,
    max_duration_ms: f64,
}

#[derive(Clone)]
struct FailureSummary {
    name: String,
    cause: String,
    count: usize,
    last_seen_ns: i128,
    trace_id: String,
    span_id: String,
}

#[derive(Clone)]
struct LogEvent {
    span_name: String,
    level: String,
    message: String,
    seen_at_ns: i128,
    trace_id: String,
    span_id: String,
}

fn aggregate(path: &Path, max_files: usize) -> Value {
    let scanned_paths = rotated_paths(path, max_files);
    let read_at = format_time(OffsetDateTime::now_utc().unix_timestamp_nanos());
    let mut loaded_any = false;
    let mut read_error = None;
    let mut parse_error_count = 0usize;
    let mut record_count = 0usize;
    let mut failure_count = 0usize;
    let mut interruption_count = 0usize;
    let mut slow_span_count = 0usize;
    let mut first_span_ns = None::<i128>;
    let mut last_span_ns = None::<i128>;
    let mut spans = HashMap::<String, SpanSummary>::new();
    let mut failures = HashMap::<(String, String), FailureSummary>::new();
    let mut latest_failures = Vec::<(SpanOccurrence, String)>::new();
    let mut occurrences = Vec::<SpanOccurrence>::new();
    let mut logs = Vec::<LogEvent>::new();
    let mut log_level_counts = BTreeMap::<String, usize>::new();

    for file_path in &scanned_paths {
        let text = match fs::read_to_string(file_path) {
            Ok(text) => {
                loaded_any = true;
                text
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => {
                read_error = Some(format!(
                    "Failed to read local trace file '{}': {error}",
                    file_path.display()
                ));
                continue;
            }
        };
        for line in text.lines().filter(|line| !line.trim().is_empty()) {
            let Ok(record) = serde_json::from_str::<Value>(line) else {
                parse_error_count += 1;
                continue;
            };
            let Some(span) = parse_span(&record) else {
                parse_error_count += 1;
                continue;
            };
            record_count += 1;
            let started_at_ns = parse_nanos(record.get("startTimeUnixNano"));
            if let Some(started_at_ns) = started_at_ns {
                first_span_ns =
                    Some(first_span_ns.map_or(started_at_ns, |current| current.min(started_at_ns)));
            }
            last_span_ns = Some(
                last_span_ns.map_or(span.ended_at_ns, |current| current.max(span.ended_at_ns)),
            );
            let exit_tag = record.pointer("/exit/_tag").and_then(Value::as_str);
            let failed = exit_tag == Some("Failure");
            let interrupted = exit_tag == Some("Interrupted");
            failure_count += usize::from(failed);
            interruption_count += usize::from(interrupted);
            slow_span_count += usize::from(span.duration_ms >= SLOW_SPAN_THRESHOLD_MS);

            let summary = spans.entry(span.name.clone()).or_default();
            summary.count += 1;
            summary.failure_count += usize::from(failed);
            summary.total_duration_ms += span.duration_ms;
            summary.max_duration_ms = summary.max_duration_ms.max(span.duration_ms);

            if failed {
                let cause = record
                    .pointer("/exit/cause")
                    .and_then(Value::as_str)
                    .unwrap_or("Failure")
                    .to_owned();
                let key = (span.name.clone(), cause.clone());
                let entry = failures.entry(key).or_insert_with(|| FailureSummary {
                    name: span.name.clone(),
                    cause: cause.clone(),
                    count: 0,
                    last_seen_ns: span.ended_at_ns,
                    trace_id: span.trace_id.clone(),
                    span_id: span.span_id.clone(),
                });
                entry.count += 1;
                if span.ended_at_ns >= entry.last_seen_ns {
                    entry.last_seen_ns = span.ended_at_ns;
                    entry.trace_id.clone_from(&span.trace_id);
                    entry.span_id.clone_from(&span.span_id);
                }
                latest_failures.push((span.clone(), cause));
            }
            collect_log_events(&record, &span, &mut logs, &mut log_level_counts);
            occurrences.push(span);
        }
    }

    let error = if !loaded_any {
        effect_some(
            json!({ "kind": "trace-file-not-found", "message": "No local trace files were found." }),
        )
    } else if let Some(message) = &read_error {
        effect_some(json!({ "kind": "trace-file-read-failed", "message": message }))
    } else {
        effect_none()
    };

    let mut top_spans = spans.into_iter().collect::<Vec<_>>();
    top_spans.sort_by(|left, right| {
        right
            .1
            .count
            .cmp(&left.1.count)
            .then_with(|| right.1.max_duration_ms.total_cmp(&left.1.max_duration_ms))
    });
    let top_spans = top_spans
        .into_iter()
        .take(TOP_LIMIT)
        .map(|(name, span)| {
            json!({
                "name": name,
                "count": span.count,
                "failureCount": span.failure_count,
                "totalDurationMs": span.total_duration_ms,
                "averageDurationMs": span.total_duration_ms / span.count as f64,
                "maxDurationMs": span.max_duration_ms,
            })
        })
        .collect::<Vec<_>>();

    occurrences.sort_by(|left, right| right.duration_ms.total_cmp(&left.duration_ms));
    let slowest_spans = occurrences
        .into_iter()
        .take(TOP_LIMIT)
        .map(span_wire)
        .collect::<Vec<_>>();
    let mut common_failures = failures.into_values().collect::<Vec<_>>();
    common_failures.sort_by(|left, right| {
        right
            .count
            .cmp(&left.count)
            .then_with(|| right.last_seen_ns.cmp(&left.last_seen_ns))
    });
    let common_failures = common_failures
        .into_iter()
        .take(TOP_LIMIT)
        .map(|failure| {
            json!({
                "name": failure.name,
                "cause": failure.cause,
                "count": failure.count,
                "lastSeenAt": format_time(failure.last_seen_ns),
                "traceId": failure.trace_id,
                "spanId": failure.span_id,
            })
        })
        .collect::<Vec<_>>();
    latest_failures.sort_by(|left, right| right.0.ended_at_ns.cmp(&left.0.ended_at_ns));
    let latest_failures = latest_failures
        .into_iter()
        .take(RECENT_LIMIT)
        .map(|(span, cause)| {
            let mut value = span_wire(span);
            value
                .as_object_mut()
                .expect("span wire object")
                .insert("cause".into(), Value::String(cause));
            value
        })
        .collect::<Vec<_>>();
    logs.sort_by(|left, right| right.seen_at_ns.cmp(&left.seen_at_ns));
    let logs = logs
        .into_iter()
        .take(RECENT_LIMIT)
        .map(|event| {
            json!({
                "spanName": event.span_name,
                "level": event.level,
                "message": event.message,
                "seenAt": format_time(event.seen_at_ns),
                "traceId": event.trace_id,
                "spanId": event.span_id,
            })
        })
        .collect::<Vec<_>>();

    json!({
        "traceFilePath": path.to_string_lossy(),
        "scannedFilePaths": scanned_paths.iter().map(|path| path.to_string_lossy()).collect::<Vec<_>>(),
        "readAt": read_at,
        "recordCount": record_count,
        "parseErrorCount": parse_error_count,
        "firstSpanAt": first_span_ns.map_or_else(effect_none, |value| effect_some(Value::String(format_time(value)))),
        "lastSpanAt": last_span_ns.map_or_else(effect_none, |value| effect_some(Value::String(format_time(value)))),
        "failureCount": failure_count,
        "interruptionCount": interruption_count,
        "slowSpanThresholdMs": SLOW_SPAN_THRESHOLD_MS as usize,
        "slowSpanCount": slow_span_count,
        "logLevelCounts": log_level_counts,
        "topSpansByCount": top_spans,
        "slowestSpans": slowest_spans,
        "commonFailures": common_failures,
        "latestFailures": latest_failures,
        "latestWarningAndErrorLogs": logs,
        "partialFailure": if loaded_any && read_error.is_some() { effect_some(Value::Bool(true)) } else { effect_none() },
        "error": error,
    })
}

fn parse_span(record: &Value) -> Option<SpanOccurrence> {
    Some(SpanOccurrence {
        name: record.get("name")?.as_str()?.trim().to_owned(),
        duration_ms: record.get("durationMs")?.as_f64()?,
        ended_at_ns: parse_nanos(record.get("endTimeUnixNano"))?,
        trace_id: record.get("traceId")?.as_str()?.trim().to_owned(),
        span_id: record.get("spanId")?.as_str()?.trim().to_owned(),
    })
    .filter(|span| !span.name.is_empty() && !span.trace_id.is_empty() && !span.span_id.is_empty())
}

fn collect_log_events(
    record: &Value,
    span: &SpanOccurrence,
    output: &mut Vec<LogEvent>,
    counts: &mut BTreeMap<String, usize>,
) {
    let Some(events) = record.get("events").and_then(Value::as_array) else {
        return;
    };
    for event in events {
        let Some(level) = event
            .pointer("/attributes/effect.logLevel")
            .and_then(Value::as_str)
        else {
            continue;
        };
        *counts.entry(level.to_owned()).or_default() += 1;
        if !matches!(
            level.to_ascii_lowercase().as_str(),
            "warning" | "warn" | "error" | "fatal"
        ) {
            continue;
        }
        output.push(LogEvent {
            span_name: span.name.clone(),
            level: level.to_owned(),
            message: event
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("Log event")
                .to_owned(),
            seen_at_ns: parse_nanos(event.get("timeUnixNano")).unwrap_or(span.ended_at_ns),
            trace_id: span.trace_id.clone(),
            span_id: span.span_id.clone(),
        });
    }
}

fn decode_otlp_records(payload: &Value) -> Vec<Value> {
    let mut output = Vec::new();
    let Some(resources) = payload.get("resourceSpans").and_then(Value::as_array) else {
        return output;
    };
    for resource in resources {
        let scopes = resource
            .get("scopeSpans")
            .or_else(|| resource.get("instrumentationLibrarySpans"))
            .and_then(Value::as_array);
        for scope in scopes.into_iter().flatten() {
            for span in scope
                .get("spans")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(record) = normalize_otlp_span(span) {
                    output.push(record);
                }
            }
        }
    }
    output
}

fn normalize_otlp_span(span: &Value) -> Option<Value> {
    let start = parse_nanos(span.get("startTimeUnixNano"))?;
    let end = parse_nanos(span.get("endTimeUnixNano"))?;
    let status = span.get("status").unwrap_or(&Value::Null);
    let failed = matches!(status.get("code"), Some(Value::Number(code)) if code.as_u64() == Some(2))
        || status
            .get("code")
            .and_then(Value::as_str)
            .is_some_and(|code| code.eq_ignore_ascii_case("STATUS_CODE_ERROR"));
    let cause = status
        .get("message")
        .and_then(Value::as_str)
        .filter(|message| !message.trim().is_empty())
        .unwrap_or("Browser trace failed");
    let events = span
        .get("events")
        .and_then(Value::as_array)
        .map(|events| events.iter().map(normalize_otlp_event).collect::<Vec<_>>())
        .unwrap_or_default();
    Some(json!({
        "type": "otlp-span",
        "name": span.get("name")?.as_str()?,
        "traceId": span.get("traceId")?.as_str()?,
        "spanId": span.get("spanId")?.as_str()?,
        "startTimeUnixNano": start.to_string(),
        "endTimeUnixNano": end.to_string(),
        "durationMs": (end - start) as f64 / 1_000_000.0,
        "events": events,
        "exit": if failed { json!({ "_tag": "Failure", "cause": redact_sensitive_text(cause) }) } else { json!({ "_tag": "Success" }) }
    }))
}

fn normalize_otlp_event(event: &Value) -> Value {
    let attributes = otlp_attributes(event.get("attributes"));
    json!({
        "name": event.get("name").and_then(Value::as_str).unwrap_or("Trace event"),
        "timeUnixNano": event.get("timeUnixNano").and_then(Value::as_str).unwrap_or("0"),
        "attributes": attributes,
    })
}

fn otlp_attributes(value: Option<&Value>) -> Map<String, Value> {
    if let Some(object) = value.and_then(Value::as_object) {
        return object.clone();
    }
    let mut output = Map::new();
    for attribute in value.and_then(Value::as_array).into_iter().flatten() {
        let Some(key) = attribute.get("key").and_then(Value::as_str) else {
            continue;
        };
        let raw = attribute.get("value").unwrap_or(&Value::Null);
        let decoded = raw
            .get("stringValue")
            .cloned()
            .or_else(|| raw.get("intValue").cloned())
            .or_else(|| raw.get("doubleValue").cloned())
            .or_else(|| raw.get("boolValue").cloned())
            .unwrap_or_else(|| raw.clone());
        output.insert(key.to_owned(), decoded);
    }
    output
}

fn error_summary(error: &Value) -> String {
    let candidate = ["detail", "message", "cause"]
        .into_iter()
        .find_map(|key| error.get(key).and_then(Value::as_str))
        .or_else(|| error.as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| error.to_string());
    candidate.chars().take(MAX_CAUSE_CHARS).collect()
}

pub(crate) fn redact_sensitive_text(input: &str) -> String {
    input
        .lines()
        .map(redact_line)
        .collect::<Vec<_>>()
        .join("\n")
}

fn redact_line(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    for marker in [
        "authorization:",
        "proxy-authorization:",
        "access_token=",
        "api_key=",
        "apikey=",
        "password=",
    ] {
        if let Some(index) = lower.find(marker) {
            let end = index + marker.len();
            return format!("{} [REDACTED]", line[..end].trim_end());
        }
    }
    redact_url_credentials(line)
}

fn redact_url_credentials(input: &str) -> String {
    let mut output = input.to_owned();
    let mut search_from = 0;
    while let Some(relative_scheme) = output[search_from..].find("://") {
        let authority_start = search_from + relative_scheme + 3;
        let authority_end = output[authority_start..]
            .find(['/', ' ', '\t', '\r', '\n'])
            .map_or(output.len(), |offset| authority_start + offset);
        let Some(at_offset) = output[authority_start..authority_end].rfind('@') else {
            search_from = authority_end;
            if search_from >= output.len() {
                break;
            }
            continue;
        };
        let at = authority_start + at_offset;
        output.replace_range(authority_start..at, "[REDACTED]");
        search_from = authority_start + "[REDACTED]@".len();
    }
    output
}

fn rotate(path: &Path, max_files: usize) -> io::Result<()> {
    if max_files == 0 {
        if path.exists() {
            fs::remove_file(path)?;
        }
        return Ok(());
    }
    let oldest = rotated_path(path, max_files);
    if oldest.exists() {
        fs::remove_file(oldest)?;
    }
    for index in (1..max_files).rev() {
        let source = rotated_path(path, index);
        if source.exists() {
            fs::rename(source, rotated_path(path, index + 1))?;
        }
    }
    if path.exists() {
        fs::rename(path, rotated_path(path, 1))?;
    }
    Ok(())
}

fn rotated_paths(path: &Path, max_files: usize) -> Vec<PathBuf> {
    (1..=max_files)
        .rev()
        .map(|index| rotated_path(path, index))
        .chain(std::iter::once(path.to_path_buf()))
        .collect()
}

fn rotated_path(path: &Path, index: usize) -> PathBuf {
    PathBuf::from(format!("{}.{index}", path.to_string_lossy()))
}

fn span_wire(span: SpanOccurrence) -> Value {
    json!({
        "name": span.name,
        "durationMs": span.duration_ms,
        "endedAt": format_time(span.ended_at_ns),
        "traceId": span.trace_id,
        "spanId": span.span_id,
    })
}

fn parse_nanos(value: Option<&Value>) -> Option<i128> {
    value?.as_str()?.parse().ok()
}

fn format_time(nanos: i128) -> String {
    OffsetDateTime::from_unix_timestamp_nanos(nanos)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH)
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}

fn effect_none() -> Value {
    json!({ "_id": "Option", "_tag": "None" })
}

fn effect_some(value: Value) -> Value {
    json!({ "_id": "Option", "_tag": "Some", "value": value })
}

fn non_empty<'a>(value: &'a str, fallback: &'a str) -> &'a str {
    if value.trim().is_empty() {
        fallback
    } else {
        value
    }
}
