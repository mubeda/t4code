#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeUtil from "node:util";

export interface RuntimeProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly processName: string;
  readonly command: string;
  readonly privateBytes: number;
  readonly workingSetBytes: number;
  readonly mainWindowTitle: string;
  readonly startedAtEpochMs?: number;
}

export interface RuntimeProcessSummary {
  readonly pid: number;
  readonly processName: string;
  readonly command: string;
  readonly privateBytes: number;
  readonly workingSetBytes: number;
  readonly mainWindowTitle: string;
}

export interface RuntimeMeasurementInput {
  readonly label: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly readyUrl?: string;
  readonly windowTitle?: string;
  readonly idleMs: number;
  readonly timeoutMs: number;
  readonly env: Readonly<Record<string, string>>;
  readonly keepRunning: boolean;
  readonly jsonOut?: string;
  readonly markdownOut?: string;
  readonly verbose?: boolean;
}

export interface RuntimeMeasurementSummary {
  readonly label: string;
  readonly rootPid: number;
  readonly sampledAt: string;
  readonly startupMs: number | null;
  readonly windowReadyMs: number | null;
  readonly readyUrl: string | null;
  readonly windowTitle: string | null;
  readonly idleMs: number;
  readonly processIds: ReadonlyArray<number>;
  readonly processCount: number;
  readonly totalPrivateBytes: number;
  readonly totalWorkingSetBytes: number;
  readonly topProcesses: ReadonlyArray<RuntimeProcessSummary>;
}

export class DesktopRuntimeMeasurementError extends Error {
  override readonly name = "DesktopRuntimeMeasurementError";
}

type LaunchedChildProcess = NodeChildProcess.ChildProcess & { readonly pid: number };

const WINDOWS_PROCESS_SAMPLER_TIMEOUT_MS = 15_000;
const WINDOWS_PROCESS_CLEANUP_TIMEOUT_MS = 15_000;

function normalizeRepeatedArgFlags(argv: ReadonlyArray<string>): ReadonlyArray<string> {
  const normalized: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (entry === "--arg") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new DesktopRuntimeMeasurementError("--arg requires a value.");
      }
      normalized.push(`--arg=${value}`);
      index += 1;
    } else if (entry !== undefined) {
      normalized.push(entry);
    }
  }
  return normalized;
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toStringArray(value: unknown): ReadonlyArray<string> {
  if (Array.isArray(value))
    return value.filter((entry): entry is string => typeof entry === "string");
  return typeof value === "string" ? [value] : [];
}

function parsePositiveInteger(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new DesktopRuntimeMeasurementError(`${label} must be a positive integer.`);
  }
  return parsed;
}

function parseEnvEntries(entries: ReadonlyArray<string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      throw new DesktopRuntimeMeasurementError(
        `Invalid --env entry '${entry}'. Expected KEY=VALUE.`,
      );
    }
    env[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return env;
}

export function parseMeasureDesktopRuntimeArgs(
  argv: ReadonlyArray<string>,
): RuntimeMeasurementInput {
  const { values } = NodeUtil.parseArgs({
    args: [...normalizeRepeatedArgFlags(argv)],
    options: {
      label: { type: "string" },
      command: { type: "string" },
      arg: { type: "string", multiple: true },
      cwd: { type: "string" },
      "ready-url": { type: "string" },
      "window-title": { type: "string" },
      "idle-ms": { type: "string" },
      "timeout-ms": { type: "string" },
      env: { type: "string", multiple: true },
      "keep-running": { type: "boolean" },
      "json-out": { type: "string" },
      "markdown-out": { type: "string" },
      verbose: { type: "boolean" },
    },
    allowPositionals: false,
  });

  const label = toOptionalString(values.label);
  const command = toOptionalString(values.command);
  if (!label) {
    throw new DesktopRuntimeMeasurementError("--label is required.");
  }
  if (!command) {
    throw new DesktopRuntimeMeasurementError("--command is required.");
  }

  return {
    label,
    command,
    args: toStringArray(values.arg),
    ...(toOptionalString(values.cwd) ? { cwd: String(values.cwd) } : {}),
    ...(toOptionalString(values["ready-url"]) ? { readyUrl: String(values["ready-url"]) } : {}),
    ...(toOptionalString(values["window-title"])
      ? { windowTitle: String(values["window-title"]) }
      : {}),
    idleMs: parsePositiveInteger(toOptionalString(values["idle-ms"]), 30_000, "--idle-ms"),
    timeoutMs: parsePositiveInteger(
      toOptionalString(values["timeout-ms"]),
      120_000,
      "--timeout-ms",
    ),
    env: parseEnvEntries(toStringArray(values.env)),
    keepRunning: values["keep-running"] === true,
    ...(toOptionalString(values["json-out"]) ? { jsonOut: String(values["json-out"]) } : {}),
    ...(toOptionalString(values["markdown-out"])
      ? { markdownOut: String(values["markdown-out"]) }
      : {}),
    ...(values.verbose === true ? { verbose: true } : {}),
  };
}

export function collectProcessTree(
  rows: ReadonlyArray<RuntimeProcessRow>,
  rootPid: number,
): ReadonlyArray<RuntimeProcessRow> {
  const rowByPid = new Map(rows.map((row) => [row.pid, row]));
  const rootStartedAtEpochMs = rowByPid.get(rootPid)?.startedAtEpochMs;
  const childrenByParent = new Map<number, RuntimeProcessRow[]>();
  for (const row of rows) {
    const bucket = childrenByParent.get(row.ppid) ?? [];
    bucket.push(row);
    childrenByParent.set(row.ppid, bucket);
  }

  const discovered = new Set<number>([rootPid]);
  const queue = [rootPid];
  for (let index = 0; index < queue.length; index += 1) {
    const pid = queue[index];
    if (pid === undefined) continue;
    for (const child of childrenByParent.get(pid) ?? []) {
      if (discovered.has(child.pid)) continue;
      if (
        rootStartedAtEpochMs !== undefined &&
        child.startedAtEpochMs !== undefined &&
        child.startedAtEpochMs + 1_000 < rootStartedAtEpochMs
      ) {
        continue;
      }
      discovered.add(child.pid);
      queue.push(child.pid);
    }
  }

  return rows.filter((row) => discovered.has(row.pid));
}

export function summarizeProcessTree(input: {
  readonly label: string;
  readonly rootPid: number;
  readonly rows: ReadonlyArray<RuntimeProcessRow>;
  readonly sampledAt: string;
  readonly startupMs?: number | null;
  readonly windowReadyMs?: number | null;
  readonly readyUrl?: string | null;
  readonly windowTitle?: string | null;
  readonly idleMs: number;
}): RuntimeMeasurementSummary {
  const tree = collectProcessTree(input.rows, input.rootPid);
  const topProcesses = tree
    .map((row) => ({
      pid: row.pid,
      processName: row.processName,
      command: row.command,
      privateBytes: row.privateBytes,
      workingSetBytes: row.workingSetBytes,
      mainWindowTitle: row.mainWindowTitle,
    }))
    .toSorted((a, b) => b.privateBytes - a.privateBytes)
    .slice(0, 12);

  return {
    label: input.label,
    rootPid: input.rootPid,
    sampledAt: input.sampledAt,
    startupMs: input.startupMs ?? null,
    windowReadyMs: input.windowReadyMs ?? null,
    readyUrl: input.readyUrl ?? null,
    windowTitle: input.windowTitle ?? null,
    idleMs: input.idleMs,
    processIds: tree.map((row) => row.pid),
    processCount: tree.length,
    totalPrivateBytes: tree.reduce((total, row) => total + row.privateBytes, 0),
    totalWorkingSetBytes: tree.reduce((total, row) => total + row.workingSetBytes, 0),
    topProcesses,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

function formatDuration(ms: number | null): string {
  return ms === null ? "not captured" : `${(ms / 1000).toFixed(2)} s`;
}

export function renderMeasurementMarkdown(summary: RuntimeMeasurementSummary): string {
  const rows = [
    ["Label", summary.label],
    ["Sampled at", summary.sampledAt],
    ["Root PID", String(summary.rootPid)],
    ["Startup readiness", formatDuration(summary.startupMs)],
    ["Window readiness", formatDuration(summary.windowReadyMs)],
    ["Idle delay", formatDuration(summary.idleMs)],
    ["Process count", String(summary.processCount)],
    ["Total private bytes", formatBytes(summary.totalPrivateBytes)],
    ["Total working set", formatBytes(summary.totalWorkingSetBytes)],
  ];

  const topProcesses = summary.topProcesses
    .map(
      (process) =>
        `| ${process.pid} | ${process.processName} | ${formatBytes(process.privateBytes)} | ${formatBytes(process.workingSetBytes)} | \`${process.command.replaceAll("|", "\\|")}\` |`,
    )
    .join("\n");

  return [
    `## Desktop Runtime Measurement: ${summary.label}`,
    "",
    "| Metric | Value |",
    "| --- | --- |",
    ...rows.map(([name, value]) => `| ${name} | ${value} |`),
    "",
    "### Top Processes",
    "",
    "| PID | Name | Private | Working Set | Command |",
    "| --- | --- | --- | --- | --- |",
    topProcesses || "| - | - | - | - | - |",
    "",
  ].join("\n");
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asOptionalEpochMs(value: unknown): number | undefined {
  const parsed = Date.parse(asString(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeWindowsRows(raw: unknown): ReadonlyArray<RuntimeProcessRow> {
  const entries = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const pid = asNumber(record.ProcessId);
    if (pid <= 0) return [];
    const startedAtEpochMs = asOptionalEpochMs(record.CreationTimeIso);
    return [
      {
        pid,
        ppid: asNumber(record.ParentProcessId),
        processName: asString(record.ProcessName),
        command: asString(record.CommandLine) || asString(record.ProcessName),
        privateBytes: asNumber(record.PrivateMemorySize64),
        workingSetBytes: asNumber(record.WorkingSet64) || asNumber(record.WorkingSetSize),
        mainWindowTitle: asString(record.MainWindowTitle),
        ...(startedAtEpochMs !== undefined ? { startedAtEpochMs } : {}),
      },
    ];
  });
}

export function buildWindowsProcessRowsCommand(): string {
  return [
    "$runtime = @{}",
    "Get-Process | ForEach-Object { $runtime[[int]$_.Id] = $_ }",
    "$rows = Get-CimInstance Win32_Process | ForEach-Object {",
    "$p = $runtime[[int]$_.ProcessId]",
    "[pscustomobject]@{",
    "ProcessId = [int]$_.ProcessId",
    "ParentProcessId = [int]$_.ParentProcessId",
    "ProcessName = if ($p) { $p.ProcessName } else { $_.Name }",
    "CommandLine = if ($_.CommandLine) { $_.CommandLine } else { $_.Name }",
    "WorkingSetSize = [double]$_.WorkingSetSize",
    "PrivateMemorySize64 = if ($p) { [double]$p.PrivateMemorySize64 } else { 0 }",
    "WorkingSet64 = if ($p) { [double]$p.WorkingSet64 } else { [double]$_.WorkingSetSize }",
    "MainWindowTitle = if ($p) { [string]$p.MainWindowTitle } else { '' }",
    "CreationTimeIso = if ($p) { try { [string]$p.StartTime.ToUniversalTime().ToString('o') } catch { '' } } else { '' }",
    "}",
    "}",
    "$rows | ConvertTo-Json -Compress -Depth 4",
  ].join("\n");
}

function readWindowsProcessRows(): ReadonlyArray<RuntimeProcessRow> {
  const command = buildWindowsProcessRowsCommand();
  const output = NodeChildProcess.execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: WINDOWS_PROCESS_SAMPLER_TIMEOUT_MS,
    },
  );
  return normalizeWindowsRows(JSON.parse(output || "[]"));
}

function readPosixProcessRows(): ReadonlyArray<RuntimeProcessRow> {
  const output = NodeChildProcess.execFileSync("ps", ["-axo", "pid=,ppid=,rss=,comm=,command="], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return output.split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) return [];
    const rssBytes = Number(match[3]) * 1024;
    return [
      {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        processName: match[4] ?? "",
        command: match[5] ?? "",
        privateBytes: rssBytes,
        workingSetBytes: rssBytes,
        mainWindowTitle: "",
      },
    ];
  });
}

function readCurrentProcessRows(): ReadonlyArray<RuntimeProcessRow> {
  // oxlint-disable-next-line t4code/no-global-process-runtime -- Standalone measurement script samples the actual host process table.
  return NodeOS.platform() === "win32" ? readWindowsProcessRows() : readPosixProcessRows();
}

function sleep(ms: number): Promise<void> {
  // @effect-diagnostics-next-line globalTimers:off - Standalone Node measurement CLI waits on real launched processes.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReadyUrl(url: string, timeoutMs: number): Promise<number> {
  const startedAt = NodePerfHooks.performance.now();
  while (NodePerfHooks.performance.now() - startedAt < timeoutMs) {
    const controller = new AbortController();
    // @effect-diagnostics-next-line globalTimers:off - Standalone Node measurement CLI bounds each readiness fetch attempt.
    const timeout = setTimeout(() => controller.abort(), 2_000);
    try {
      // @effect-diagnostics-next-line globalFetch:off - Standalone Node measurement CLI polls a user-provided readiness URL.
      const response = await fetch(url, { signal: controller.signal });
      if (response.status < 500) {
        await response.body?.cancel().catch(() => undefined);
        return NodePerfHooks.performance.now() - startedAt;
      }
      await response.body?.cancel().catch(() => undefined);
    } catch {
      // Keep polling until timeout.
    } finally {
      clearTimeout(timeout);
    }
    await sleep(500);
  }
  throw new DesktopRuntimeMeasurementError(`Timed out waiting for ready URL: ${url}`);
}

async function waitForWindowTitle(
  rootPid: number,
  titleNeedle: string,
  timeoutMs: number,
): Promise<number> {
  const startedAt = NodePerfHooks.performance.now();
  const normalizedNeedle = titleNeedle.toLowerCase();
  while (NodePerfHooks.performance.now() - startedAt < timeoutMs) {
    const tree = collectProcessTree(readCurrentProcessRows(), rootPid);
    if (tree.some((row) => row.mainWindowTitle.toLowerCase().includes(normalizedNeedle))) {
      return NodePerfHooks.performance.now() - startedAt;
    }
    await sleep(500);
  }
  throw new DesktopRuntimeMeasurementError(`Timed out waiting for window title: ${titleNeedle}`);
}

function parseReadyUrlPort(readyUrl: string | undefined): number | undefined {
  if (!readyUrl) return undefined;
  try {
    const url = new URL(readyUrl);
    const port = Number(url.port);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

function runWindowsCleanupCommand(command: string): void {
  try {
    NodeChildProcess.execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      {
        encoding: "utf8",
        stdio: "ignore",
        timeout: WINDOWS_PROCESS_CLEANUP_TIMEOUT_MS,
      },
    );
  } catch {
    // Cleanup is best-effort; measurement results/errors should not be masked.
  }
}

function cleanupWindowsRuntime(rootPid: number, readyUrl: string | undefined): void {
  try {
    NodeChildProcess.execFileSync("taskkill.exe", ["/PID", String(rootPid), "/T", "/F"], {
      encoding: "utf8",
      stdio: "ignore",
      timeout: WINDOWS_PROCESS_CLEANUP_TIMEOUT_MS,
    });
  } catch {
    // The host process may have exited after spawning a backend sidecar.
  }

  const readyPort = parseReadyUrlPort(readyUrl);
  if (readyPort === undefined) return;
  runWindowsCleanupCommand(
    [
      `$connections = Get-NetTCPConnection -LocalPort ${readyPort} -ErrorAction SilentlyContinue`,
      "$connections | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {",
      "if ($_ -gt 0) { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }",
      "}",
    ].join("\n"),
  );
}

function cleanupRuntimeProcess(rootPid: number, readyUrl: string | undefined): void {
  // oxlint-disable-next-line t4code/no-global-process-runtime -- Standalone measurement script cleans up the launched host process on the actual platform.
  if (NodeOS.platform() === "win32") {
    cleanupWindowsRuntime(rootPid, readyUrl);
    return;
  }
  try {
    process.kill(rootPid, "SIGTERM");
  } catch {
    // Already exited.
  }
}

function logMeasurementPhase(input: RuntimeMeasurementInput, message: string): void {
  if (!input.verbose) return;
  process.stderr.write(`[measure-desktop-runtime] ${message}\n`);
}

function spawnDesktopProcess(input: RuntimeMeasurementInput): Promise<LaunchedChildProcess> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(input.command, [...input.args], {
      cwd: input.cwd,
      env: { ...process.env, ...input.env },
      stdio: "ignore",
      windowsHide: false,
    });

    let settled = false;
    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      reject(
        new DesktopRuntimeMeasurementError(
          `Failed to start desktop process '${input.command}': ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        ),
      );
    };

    child.once("error", fail);
    if (child.pid === undefined) {
      queueMicrotask(() => fail("process id was not assigned"));
      return;
    }

    settled = true;
    child.off("error", fail);
    child.on("error", () => {
      // Avoid unhandled process errors after the launch phase. Runtime cleanup
      // and readiness checks report the actionable measurement failures.
    });
    resolve(child as LaunchedChildProcess);
  });
}

export async function measureDesktopRuntime(
  input: RuntimeMeasurementInput,
): Promise<RuntimeMeasurementSummary> {
  const child = await spawnDesktopProcess(input);
  child.unref();
  logMeasurementPhase(input, `spawned pid ${child.pid}`);

  let startupMs: number | null = null;
  let windowReadyMs: number | null = null;
  const startedAt = NodePerfHooks.performance.now();
  try {
    const readiness: Array<Promise<void>> = [];
    if (input.readyUrl) {
      readiness.push(
        waitForReadyUrl(input.readyUrl, input.timeoutMs).then((duration) => {
          startupMs = duration;
        }),
      );
    }
    if (input.windowTitle) {
      readiness.push(
        waitForWindowTitle(child.pid, input.windowTitle, input.timeoutMs).then((duration) => {
          windowReadyMs = duration;
        }),
      );
    }
    if (readiness.length > 0) {
      logMeasurementPhase(input, "waiting for readiness gates");
      await Promise.all(readiness);
      logMeasurementPhase(input, "readiness gates completed");
    } else {
      startupMs = NodePerfHooks.performance.now() - startedAt;
    }

    logMeasurementPhase(input, `idling for ${input.idleMs} ms`);
    await sleep(input.idleMs);
    logMeasurementPhase(input, "sampling process table");
    const rows = readCurrentProcessRows();
    logMeasurementPhase(input, `sampled ${rows.length} process rows`);
    return summarizeProcessTree({
      label: input.label,
      rootPid: child.pid,
      rows,
      // @effect-diagnostics-next-line globalDate:off - Standalone Node measurement CLI records a wall-clock sample timestamp.
      sampledAt: new Date().toISOString(),
      startupMs,
      windowReadyMs,
      readyUrl: input.readyUrl ?? null,
      windowTitle: input.windowTitle ?? null,
      idleMs: input.idleMs,
    });
  } finally {
    if (!input.keepRunning && !child.killed) {
      logMeasurementPhase(input, "cleanup starting");
      cleanupRuntimeProcess(child.pid, input.readyUrl);
      logMeasurementPhase(input, "cleanup completed");
    }
  }
}

function writeTextFile(filePath: string, text: string): void {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.resolve(filePath)), { recursive: true });
  NodeFS.writeFileSync(filePath, text);
}

if (import.meta.main) {
  try {
    const input = parseMeasureDesktopRuntimeArgs(process.argv.slice(2));
    const summary = await measureDesktopRuntime(input);
    const json = `${JSON.stringify(summary, null, 2)}\n`;
    if (input.jsonOut) writeTextFile(input.jsonOut, json);
    if (input.markdownOut) writeTextFile(input.markdownOut, renderMeasurementMarkdown(summary));
    process.stdout.write(json);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
