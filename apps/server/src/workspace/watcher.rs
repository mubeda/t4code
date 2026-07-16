use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, SystemTime};

use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchEvent {
    pub changed_paths: Vec<PathBuf>,
}

#[derive(Clone)]
pub struct WorkspaceWatcher {
    poll_interval: Duration,
    coalesce_window: Duration,
    channel_capacity: usize,
    active: Arc<AtomicUsize>,
}

impl WorkspaceWatcher {
    pub fn new(
        poll_interval: Duration,
        coalesce_window: Duration,
        channel_capacity: usize,
    ) -> Self {
        Self {
            poll_interval,
            coalesce_window,
            channel_capacity: channel_capacity.max(1),
            active: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub fn watch(&self, root: PathBuf) -> WatchSubscription {
        let cancellation = CancellationToken::new();
        let task_cancellation = cancellation.clone();
        let (sender, receiver) = mpsc::channel(self.channel_capacity);
        let active = Arc::clone(&self.active);
        let poll_interval = self.poll_interval;
        let coalesce_window = self.coalesce_window;
        active.fetch_add(1, Ordering::Relaxed);
        let task = tokio::spawn(async move {
            let mut previous = BTreeMap::new();
            let mut pending = BTreeSet::new();
            let mut deadline = None;
            let mut interval = tokio::time::interval(poll_interval);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    () = task_cancellation.cancelled() => break,
                    _ = interval.tick() => {
                        let current = snapshot(&root, 10_000).await;
                        let changed = changed_paths(&previous, &current);
                        for path in changed.iter().cloned() {
                            pending.insert(path);
                        }
                        previous = current;
                        if !changed.is_empty() {
                            deadline = Some(tokio::time::Instant::now() + coalesce_window);
                        }
                        if deadline.is_some_and(|when| tokio::time::Instant::now() >= when) {
                            let event = WatchEvent {
                                changed_paths: std::mem::take(&mut pending).into_iter().collect(),
                            };
                            let _ = sender.try_send(event);
                            deadline = None;
                        }
                    }
                }
            }
            active.fetch_sub(1, Ordering::Relaxed);
        });
        WatchSubscription {
            receiver,
            cancellation,
            task: Some(task),
        }
    }

    pub fn active_watchers(&self) -> usize {
        self.active.load(Ordering::Relaxed)
    }
}

pub struct WatchSubscription {
    receiver: mpsc::Receiver<WatchEvent>,
    cancellation: CancellationToken,
    task: Option<JoinHandle<()>>,
}

impl WatchSubscription {
    pub async fn recv(&mut self) -> Option<WatchEvent> {
        self.receiver.recv().await
    }

    pub fn try_recv(&mut self) -> Result<WatchEvent, mpsc::error::TryRecvError> {
        self.receiver.try_recv()
    }

    pub fn cancel(&self) {
        self.cancellation.cancel();
    }

    pub async fn stopped(&mut self) {
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

impl Drop for WatchSubscription {
    fn drop(&mut self) {
        self.cancellation.cancel();
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

async fn snapshot(root: &Path, max_entries: usize) -> BTreeMap<PathBuf, (u64, Option<SystemTime>)> {
    let root = root.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut output = BTreeMap::new();
        let mut stack = vec![root];
        while let Some(directory) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(directory) else {
                continue;
            };
            for entry in entries.flatten() {
                if output.len() >= max_entries {
                    return output;
                }
                let path = entry.path();
                let Ok(metadata) = entry.metadata() else {
                    continue;
                };
                output.insert(path.clone(), (metadata.len(), metadata.modified().ok()));
                if metadata.is_dir() && !metadata.file_type().is_symlink() {
                    stack.push(path);
                }
            }
        }
        output
    })
    .await
    .unwrap_or_default()
}

fn changed_paths(
    previous: &BTreeMap<PathBuf, (u64, Option<SystemTime>)>,
    current: &BTreeMap<PathBuf, (u64, Option<SystemTime>)>,
) -> Vec<PathBuf> {
    previous
        .keys()
        .chain(current.keys())
        .filter(|path| previous.get(*path) != current.get(*path))
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}
