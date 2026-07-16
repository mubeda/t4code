use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::{
    GitCommandError, GitRepository, VcsStatusLocalResult, VcsStatusRemoteResult,
    VcsStatusStreamEvent,
};

#[derive(Clone)]
pub struct StatusBroadcaster {
    inner: Arc<Inner>,
}

struct Inner {
    repository: Arc<GitRepository>,
    refresh_interval: Duration,
    subscriber_capacity: usize,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    next_subscriber_id: u64,
    repositories: HashMap<PathBuf, RepositoryState>,
}

struct RepositoryState {
    local: VcsStatusLocalResult,
    remote: Option<Option<VcsStatusRemoteResult>>,
    subscribers: HashMap<u64, mpsc::Sender<VcsStatusStreamEvent>>,
    poller_cancellation: CancellationToken,
}

pub struct StatusSubscription {
    receiver: mpsc::Receiver<VcsStatusStreamEvent>,
    cancellation: CancellationToken,
    broadcaster: StatusBroadcaster,
    cwd: PathBuf,
    subscriber_id: u64,
}

impl StatusBroadcaster {
    #[must_use]
    pub fn new(
        repository: Arc<GitRepository>,
        refresh_interval: Duration,
        subscriber_capacity: usize,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                repository,
                refresh_interval,
                subscriber_capacity: subscriber_capacity.max(1),
                state: Mutex::new(State::default()),
            }),
        }
    }

    pub async fn subscribe(
        &self,
        cwd: PathBuf,
        cancellation: CancellationToken,
    ) -> Result<StatusSubscription, GitCommandError> {
        let cwd = tokio::fs::canonicalize(&cwd).await.unwrap_or(cwd);
        let local = self
            .inner
            .repository
            .local_status(&cwd, &cancellation)
            .await?;
        let (sender, receiver) = mpsc::channel(self.inner.subscriber_capacity);

        let (subscriber_id, start_poller, poller_cancellation) = {
            let mut state = self.lock_state();
            let subscriber_id = state.next_subscriber_id;
            state.next_subscriber_id = state.next_subscriber_id.wrapping_add(1);
            let start_poller = !state.repositories.contains_key(&cwd);
            let entry = state
                .repositories
                .entry(cwd.clone())
                .or_insert_with(|| RepositoryState {
                    local: local.clone(),
                    remote: None,
                    subscribers: HashMap::new(),
                    poller_cancellation: CancellationToken::new(),
                });
            entry.subscribers.insert(subscriber_id, sender);
            let initial_remote = entry.remote.clone().flatten();
            entry
                .subscribers
                .get(&subscriber_id)
                .expect("subscriber was just registered")
                .try_send(VcsStatusStreamEvent::Snapshot {
                    local,
                    remote: initial_remote.clone(),
                })
                .expect("new bounded subscription has capacity for its snapshot");
            (
                subscriber_id,
                start_poller,
                entry.poller_cancellation.clone(),
            )
        };
        if start_poller {
            self.spawn_status_poller(cwd.clone(), poller_cancellation);
        }
        Ok(StatusSubscription {
            receiver,
            cancellation,
            broadcaster: self.clone(),
            cwd,
            subscriber_id,
        })
    }

    pub async fn refresh_local(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<VcsStatusLocalResult, GitCommandError> {
        let cwd = tokio::fs::canonicalize(cwd)
            .await
            .unwrap_or_else(|_| cwd.to_path_buf());
        let local = self
            .inner
            .repository
            .local_status(&cwd, cancellation)
            .await?;
        let event = VcsStatusStreamEvent::LocalUpdated {
            local: local.clone(),
        };
        let mut state = self.lock_state();
        let mut remove_repository = false;
        if let Some(entry) = state.repositories.get_mut(&cwd)
            && entry.local != local
        {
            entry.local = local.clone();
            publish(entry, event);
            remove_repository = entry.subscribers.is_empty();
        }
        if remove_repository && let Some(entry) = state.repositories.remove(&cwd) {
            entry.poller_cancellation.cancel();
        }
        Ok(local)
    }

    #[must_use]
    pub fn active_poller_count(&self) -> usize {
        self.lock_state().repositories.len()
    }

    fn spawn_status_poller(&self, cwd: PathBuf, cancellation: CancellationToken) {
        let broadcaster = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(broadcaster.inner.refresh_interval);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tokio::select! {
                    _ = cancellation.cancelled() => break,
                    _ = interval.tick() => {
                        let _ = broadcaster.refresh_local(&cwd, &cancellation).await;
                        let result = broadcaster
                            .inner
                            .repository
                            .refresh_remote_status(&cwd, &cancellation)
                            .await;
                        if let Ok(remote) = result {
                            let mut state = broadcaster.lock_state();
                            let Some(entry) = state.repositories.get_mut(&cwd) else {
                                break;
                            };
                            if entry.remote.as_ref() != Some(&remote) {
                                entry.remote = Some(remote.clone());
                                publish(entry, VcsStatusStreamEvent::RemoteUpdated { remote });
                            }
                            let remove_repository = entry.subscribers.is_empty();
                            if remove_repository {
                                if let Some(entry) = state.repositories.remove(&cwd) {
                                    entry.poller_cancellation.cancel();
                                }
                                break;
                            }
                        }
                    }
                }
            }
        });
    }

    fn release(&self, cwd: &Path, subscriber_id: u64) {
        let mut state = self.lock_state();
        let should_remove = if let Some(entry) = state.repositories.get_mut(cwd) {
            entry.subscribers.remove(&subscriber_id);
            entry.subscribers.is_empty()
        } else {
            false
        };
        if should_remove && let Some(entry) = state.repositories.remove(cwd) {
            entry.poller_cancellation.cancel();
        }
    }

    fn lock_state(&self) -> MutexGuard<'_, State> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl StatusSubscription {
    pub async fn recv(&mut self) -> Option<VcsStatusStreamEvent> {
        tokio::select! {
            _ = self.cancellation.cancelled() => None,
            event = self.receiver.recv() => event,
        }
    }
}

impl Drop for StatusSubscription {
    fn drop(&mut self) {
        self.broadcaster.release(&self.cwd, self.subscriber_id);
    }
}

fn publish(entry: &mut RepositoryState, event: VcsStatusStreamEvent) {
    entry
        .subscribers
        .retain(|_, subscriber| match subscriber.try_send(event.clone()) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(_)) => false,
            Err(mpsc::error::TrySendError::Closed(_)) => false,
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subscriber_capacity_is_never_zero() {
        let broadcaster =
            StatusBroadcaster::new(Arc::new(GitRepository::default()), Duration::ZERO, 0);
        assert_eq!(broadcaster.inner.subscriber_capacity, 1);
    }
}
