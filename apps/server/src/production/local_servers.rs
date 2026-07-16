use std::{collections::BTreeMap, time::Duration};

#[cfg(target_os = "linux")]
use std::net::Ipv4Addr;

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

pub(crate) const SCAN_INTERVAL: Duration = Duration::from_secs(1);
#[cfg(any(windows, target_os = "macos"))]
const COMMAND_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_SERVERS: usize = 256;

#[derive(Clone, Debug, Eq, PartialEq)]
struct Listener {
    host: String,
    port: u16,
    pid: Option<u32>,
}

pub(crate) async fn discover(cancellation: &CancellationToken) -> Vec<Value> {
    let listeners = platform_listeners(cancellation).await;
    let names = process_names(listeners.iter().filter_map(|listener| listener.pid));
    listeners
        .into_iter()
        .take(MAX_SERVERS)
        .map(|listener| {
            let process_name = listener.pid.and_then(|pid| names.get(&pid)).cloned();
            json!({
                "host": listener.host,
                "port": listener.port,
                "url": format!("http://{}:{}/", listener.host, listener.port),
                "processName": process_name,
                "pid": listener.pid,
                "terminal": null,
            })
        })
        .collect()
}

fn normalize(mut listeners: Vec<Listener>) -> Vec<Listener> {
    for listener in &mut listeners {
        if matches!(listener.host.as_str(), "0.0.0.0" | "::" | "::1" | "*") {
            listener.host = "127.0.0.1".to_owned();
        }
    }
    listeners
        .into_iter()
        .filter(|listener| listener.host == "127.0.0.1")
        .fold(BTreeMap::new(), |mut by_address, listener| {
            by_address
                .entry((listener.host.clone(), listener.port))
                .and_modify(|existing: &mut Listener| {
                    if existing.pid.is_none() {
                        existing.pid = listener.pid;
                    }
                })
                .or_insert(listener);
            by_address
        })
        .into_values()
        .collect()
}

#[cfg(windows)]
async fn platform_listeners(cancellation: &CancellationToken) -> Vec<Listener> {
    let mut command = tokio::process::Command::new("netstat.exe");
    command.args(["-ano", "-p", "tcp"]).kill_on_drop(true);
    let output = tokio::select! {
        () = cancellation.cancelled() => return Vec::new(),
        output = tokio::time::timeout(COMMAND_TIMEOUT, command.output()) => output,
    };
    let Ok(Ok(output)) = output else {
        return Vec::new();
    };
    normalize(parse_netstat(&String::from_utf8_lossy(&output.stdout)))
}

#[cfg(windows)]
fn parse_netstat(output: &str) -> Vec<Listener> {
    output
        .lines()
        .filter_map(|line| {
            let fields = line.split_whitespace().collect::<Vec<_>>();
            if fields.len() < 5
                || !fields[0].eq_ignore_ascii_case("TCP")
                || !fields[3].eq_ignore_ascii_case("LISTENING")
            {
                return None;
            }
            let (host, port) = split_address(fields[1])?;
            Some(Listener {
                host,
                port,
                pid: fields[4].parse().ok().filter(|pid| *pid > 0),
            })
        })
        .collect()
}

#[cfg(target_os = "linux")]
async fn platform_listeners(cancellation: &CancellationToken) -> Vec<Listener> {
    tokio::select! {
        () = cancellation.cancelled() => Vec::new(),
        result = async {
            tokio::join!(
                tokio::fs::read_to_string("/proc/net/tcp"),
                tokio::fs::read_to_string("/proc/net/tcp6")
            )
        } => {
            let (ipv4, ipv6) = result;
            let mut listeners = ipv4.map_or_else(|_| Vec::new(), |content| parse_proc_tcp(&content));
            listeners.extend(ipv6.map_or_else(|_| Vec::new(), |content| parse_proc_tcp6(&content)));
            normalize(listeners)
        }
    }
}

#[cfg(target_os = "linux")]
fn parse_proc_tcp(input: &str) -> Vec<Listener> {
    input
        .lines()
        .skip(1)
        .filter_map(|line| {
            let fields = line.split_whitespace().collect::<Vec<_>>();
            if fields.len() < 4 || fields[3] != "0A" {
                return None;
            }
            let (address, port) = fields[1].split_once(':')?;
            let encoded = u32::from_str_radix(address, 16).ok()?;
            let host = Ipv4Addr::from(encoded.to_le_bytes()).to_string();
            Some(Listener {
                host,
                port: u16::from_str_radix(port, 16).ok()?,
                pid: None,
            })
        })
        .collect()
}

#[cfg(target_os = "linux")]
fn parse_proc_tcp6(input: &str) -> Vec<Listener> {
    input
        .lines()
        .skip(1)
        .filter_map(|line| {
            let fields = line.split_whitespace().collect::<Vec<_>>();
            if fields.len() < 4 || fields[3] != "0A" {
                return None;
            }
            let (address, port) = fields[1].split_once(':')?;
            let host = if address.chars().all(|character| character == '0') {
                "0.0.0.0"
            } else if address == "00000000000000000000000001000000" {
                "127.0.0.1"
            } else {
                return None;
            };
            Some(Listener {
                host: host.to_owned(),
                port: u16::from_str_radix(port, 16).ok()?,
                pid: None,
            })
        })
        .collect()
}

#[cfg(target_os = "macos")]
async fn platform_listeners(cancellation: &CancellationToken) -> Vec<Listener> {
    let mut command = tokio::process::Command::new("/usr/sbin/lsof");
    command
        .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"])
        .kill_on_drop(true);
    let output = tokio::select! {
        () = cancellation.cancelled() => return Vec::new(),
        output = tokio::time::timeout(COMMAND_TIMEOUT, command.output()) => output,
    };
    let Ok(Ok(output)) = output else {
        return Vec::new();
    };
    normalize(parse_lsof(&String::from_utf8_lossy(&output.stdout)))
}

#[cfg(target_os = "macos")]
fn parse_lsof(output: &str) -> Vec<Listener> {
    let mut pid = None;
    let mut listeners = Vec::new();
    for line in output.lines() {
        if let Some(value) = line.strip_prefix('p') {
            pid = value.parse().ok();
        } else if let Some(value) = line.strip_prefix('n') {
            let address = value.split(" (LISTEN)").next().unwrap_or(value);
            if let Some((host, port)) = split_address(address) {
                listeners.push(Listener { host, port, pid });
            }
        }
    }
    listeners
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
async fn platform_listeners(_cancellation: &CancellationToken) -> Vec<Listener> {
    Vec::new()
}

#[cfg(any(windows, target_os = "macos"))]
fn split_address(input: &str) -> Option<(String, u16)> {
    if let Some(rest) = input.strip_prefix('[') {
        let (host, port) = rest.split_once("]:")?;
        return Some((host.to_owned(), port.parse().ok()?));
    }
    let (host, port) = input.rsplit_once(':')?;
    Some((host.to_owned(), port.parse().ok()?))
}

fn process_names(pids: impl Iterator<Item = u32>) -> BTreeMap<u32, String> {
    use sysinfo::{Pid, ProcessesToUpdate, System};

    let pids = pids.collect::<std::collections::BTreeSet<_>>();
    if pids.is_empty() {
        return BTreeMap::new();
    }
    let sysinfo_pids = pids.iter().copied().map(Pid::from_u32).collect::<Vec<_>>();
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::Some(&sysinfo_pids), true);
    pids.into_iter()
        .filter_map(|pid| {
            system
                .process(Pid::from_u32(pid))
                .map(|process| (pid, process.name().to_string_lossy().into_owned()))
        })
        .filter(|(_, name)| !name.trim().is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wildcard_and_ipv6_loopback_listeners_normalize_to_loopback_http() {
        let listeners = normalize(vec![
            Listener {
                host: "*".to_owned(),
                port: 3000,
                pid: Some(1),
            },
            Listener {
                host: "::1".to_owned(),
                port: 4000,
                pid: Some(2),
            },
        ]);

        assert_eq!(listeners.len(), 2);
        assert!(
            listeners
                .iter()
                .all(|listener| listener.host == "127.0.0.1")
        );
    }
}
