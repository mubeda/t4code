use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
    time::{Duration, Instant},
};

use super::{
    AttributionKind, AttributionScope, PROCESS_CLAIM_LABEL_MAX_SCALARS, ProcessClaim,
    ProcessIdentity, ProcessRow, bound_diagnostic_string,
};

const REGISTRY_CAPACITY: usize = 512;
const UNBOUND_REGISTRATION_TTL: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RegistrationSource {
    Provider,
    Terminal,
    DesktopUi,
    Helper,
}

#[derive(Clone, Debug)]
pub struct ProcessRegistrationMetadata {
    pub scope: AttributionScope,
    pub kind: AttributionKind,
    pub label: String,
    pub source: RegistrationSource,
}

#[derive(Clone, Debug)]
pub struct ProcessAttributionRegistry {
    inner: Arc<Mutex<RegistryState>>,
}

#[derive(Debug)]
pub struct ProcessRegistration {
    registration_id: u64,
    registry: Weak<Mutex<RegistryState>>,
}

#[derive(Debug)]
struct RegistryState {
    next_registration_id: u64,
    entries: HashMap<u64, RegistryEntry>,
}

#[derive(Debug)]
struct RegistryEntry {
    pid: u32,
    metadata: ProcessRegistrationMetadata,
    binding: RegistrationBinding,
}

#[derive(Debug)]
enum RegistrationBinding {
    Unbound { deadline: Instant },
    Bound(ProcessIdentity),
}

impl ProcessAttributionRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(RegistryState {
                next_registration_id: 0,
                entries: HashMap::new(),
            })),
        }
    }

    pub fn register_pid(
        &self,
        pid: u32,
        mut metadata: ProcessRegistrationMetadata,
    ) -> Option<ProcessRegistration> {
        let now = Instant::now();
        let mut state = lock_state(&self.inner);
        state.entries.retain(|_, entry| {
            !matches!(entry.binding, RegistrationBinding::Unbound { deadline } if deadline <= now)
        });
        if state.entries.len() >= REGISTRY_CAPACITY {
            tracing::warn!(
                capacity = REGISTRY_CAPACITY,
                "process attribution registry is full; using external fallback"
            );
            return None;
        }

        metadata.label = normalize_label(&metadata.label);
        let registration_id = state.next_registration_id;
        state.next_registration_id = state.next_registration_id.wrapping_add(1);
        state.entries.insert(
            registration_id,
            RegistryEntry {
                pid,
                metadata,
                binding: RegistrationBinding::Unbound {
                    deadline: now + UNBOUND_REGISTRATION_TTL,
                },
            },
        );

        Some(ProcessRegistration {
            registration_id,
            registry: Arc::downgrade(&self.inner),
        })
    }

    #[must_use]
    pub fn bind_and_snapshot(&self, rows: &[ProcessRow], now: Instant) -> Vec<ProcessClaim> {
        let identities = rows
            .iter()
            .map(|row| ProcessIdentity {
                pid: row.pid,
                started_at: row.started_at,
            })
            .collect::<Vec<_>>();
        let mut state = lock_state(&self.inner);
        state.entries.retain(|_, entry| match entry.binding {
            RegistrationBinding::Unbound { deadline } => deadline > now,
            RegistrationBinding::Bound(identity) => identities.contains(&identity),
        });

        for entry in state.entries.values_mut() {
            if matches!(entry.binding, RegistrationBinding::Unbound { .. })
                && let Some(identity) = identities
                    .iter()
                    .copied()
                    .find(|identity| identity.pid == entry.pid)
            {
                entry.binding = RegistrationBinding::Bound(identity);
            }
        }

        let mut snapshot = state
            .entries
            .iter()
            .filter_map(|(registration_id, entry)| match entry.binding {
                RegistrationBinding::Bound(identity) => Some((
                    *registration_id,
                    ProcessClaim {
                        identity,
                        scope: entry.metadata.scope,
                        kind: entry.metadata.kind,
                        label: entry.metadata.label.clone(),
                    },
                )),
                RegistrationBinding::Unbound { .. } => None,
            })
            .collect::<Vec<_>>();
        snapshot.sort_by_key(|(registration_id, _)| *registration_id);
        snapshot.into_iter().map(|(_, claim)| claim).collect()
    }
}

impl Default for ProcessAttributionRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl ProcessRegistration {
    pub fn unregister(&self) {
        if let Some(registry) = self.registry.upgrade() {
            lock_state(&registry).entries.remove(&self.registration_id);
        }
    }
}

impl Drop for ProcessRegistration {
    fn drop(&mut self) {
        self.unregister();
    }
}

fn lock_state(registry: &Mutex<RegistryState>) -> std::sync::MutexGuard<'_, RegistryState> {
    registry
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn normalize_label(label: &str) -> String {
    let normalized = label.split_whitespace().collect::<Vec<_>>().join(" ");
    bound_diagnostic_string(&normalized, PROCESS_CLAIM_LABEL_MAX_SCALARS)
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;
    use crate::diagnostics::{
        AttributionKind, AttributionScope, ProcessIdentity, ProcessRow, ResourceAttributor,
        UiCoverage,
    };

    fn metadata(label: &str) -> ProcessRegistrationMetadata {
        ProcessRegistrationMetadata {
            scope: AttributionScope::External,
            kind: AttributionKind::Provider,
            label: label.to_owned(),
            source: RegistrationSource::Provider,
        }
    }

    fn row(pid: u32, ppid: u32, started_at: u64) -> ProcessRow {
        ProcessRow {
            pid,
            started_at,
            ppid,
            pgid: None,
            status: "Run".to_owned(),
            cpu_percent: 0.0,
            cpu_core_percent: Some(0.0),
            rss_bytes: 0,
            elapsed: "00:00:00".to_owned(),
            command: format!("process-{pid}"),
        }
    }

    #[test]
    fn registration_appears_in_a_snapshot_after_its_first_matching_row() {
        let registry = ProcessAttributionRegistry::new();
        let _registration = registry
            .register_pid(42, metadata("external/provider"))
            .expect("registration should fit");

        let claims = registry.bind_and_snapshot(&[row(42, 1, 100)], Instant::now());

        assert_eq!(claims.len(), 1);
        assert_eq!(
            claims[0].identity,
            ProcessIdentity {
                pid: 42,
                started_at: 100
            }
        );
    }

    #[test]
    fn first_matching_row_binds_registration_to_its_exact_start_identity() {
        let registry = ProcessAttributionRegistry::new();
        let _registration = registry
            .register_pid(42, metadata("external/provider"))
            .expect("registration should fit");

        let first = registry.bind_and_snapshot(&[row(42, 1, 100)], Instant::now());
        let second = registry.bind_and_snapshot(&[row(42, 1, 100)], Instant::now());

        assert_eq!(
            first[0].identity,
            ProcessIdentity {
                pid: 42,
                started_at: 100
            }
        );
        assert_eq!(
            second[0].identity,
            ProcessIdentity {
                pid: 42,
                started_at: 100
            }
        );
    }

    #[test]
    fn bound_registration_refuses_pid_reuse_with_a_different_start_identity() {
        let registry = ProcessAttributionRegistry::new();
        let _registration = registry
            .register_pid(42, metadata("external/provider"))
            .expect("registration should fit");
        let now = Instant::now();

        let _ = registry.bind_and_snapshot(&[row(42, 1, 100)], now);
        let claims = registry.bind_and_snapshot(&[row(42, 1, 200)], now);

        assert!(claims.is_empty());
    }

    #[test]
    fn dropping_registration_unregisters_immediately() {
        let registry = ProcessAttributionRegistry::new();
        let registration = registry
            .register_pid(42, metadata("external/provider"))
            .expect("registration should fit");
        drop(registration);

        assert!(
            registry
                .bind_and_snapshot(&[row(42, 1, 100)], Instant::now())
                .is_empty()
        );
    }

    #[test]
    fn explicit_unregister_is_idempotent() {
        let registry = ProcessAttributionRegistry::new();
        let registration = registry
            .register_pid(42, metadata("external/provider"))
            .expect("registration should fit");

        registration.unregister();
        registration.unregister();

        assert!(
            registry
                .bind_and_snapshot(&[row(42, 1, 100)], Instant::now())
                .is_empty()
        );
    }

    #[test]
    fn unbound_registration_expires_after_ten_seconds() {
        let registry = ProcessAttributionRegistry::new();
        let _registration = registry
            .register_pid(42, metadata("external/provider"))
            .expect("registration should fit");
        let registered_at = Instant::now();

        let claims =
            registry.bind_and_snapshot(&[row(42, 1, 100)], registered_at + Duration::from_secs(10));

        assert!(claims.is_empty());
    }

    #[test]
    fn missing_bound_identity_is_pruned_after_a_sample() {
        let registry = ProcessAttributionRegistry::new();
        let _registration = registry
            .register_pid(42, metadata("external/provider"))
            .expect("registration should fit");
        let now = Instant::now();
        let _ = registry.bind_and_snapshot(&[row(42, 1, 100)], now);

        assert!(registry.bind_and_snapshot(&[], now).is_empty());
        assert!(
            registry
                .bind_and_snapshot(&[row(42, 1, 100)], now)
                .is_empty()
        );
    }

    #[test]
    fn capacity_does_not_evict_a_still_owned_registration() {
        let registry = ProcessAttributionRegistry::new();
        let registrations = (0..512)
            .map(|pid| {
                registry
                    .register_pid(pid, metadata("external/provider"))
                    .expect("registration should fit")
            })
            .collect::<Vec<_>>();

        assert!(registry.register_pid(999, metadata("overflow")).is_none());
        assert_eq!(
            registry.bind_and_snapshot(&[row(0, 1, 100)], Instant::now()),
            vec![crate::diagnostics::ProcessClaim {
                identity: ProcessIdentity {
                    pid: 0,
                    started_at: 100
                },
                scope: AttributionScope::External,
                kind: AttributionKind::Provider,
                label: "external/provider".to_owned(),
            }]
        );
        assert_eq!(registrations.len(), 512);
    }

    #[test]
    fn labels_are_normalized_and_bounded_to_eighty_utf8_characters() {
        let registry = ProcessAttributionRegistry::new();
        let _registration = registry
            .register_pid(42, metadata(&format!("  provider\n{}  ", "é".repeat(100))))
            .expect("registration should fit");

        let claims = registry.bind_and_snapshot(&[row(42, 1, 100)], Instant::now());

        assert_eq!(claims[0].label, format!("provider {}", "é".repeat(71)));
        assert_eq!(claims[0].label.chars().count(), 80);
    }

    #[test]
    fn snapshots_are_owned_before_attribution_runs() {
        let registry = ProcessAttributionRegistry::new();
        let _registration = registry
            .register_pid(42, metadata("external/provider"))
            .expect("registration should fit");
        let rows = [row(1, 0, 10), row(42, 1, 20)];
        let claims = registry.bind_and_snapshot(&rows, Instant::now());

        let state_guard = lock_state(registry.inner.as_ref());
        let attribution = ResourceAttributor::attribute(
            &rows,
            ProcessIdentity {
                pid: 1,
                started_at: 10,
            },
            &claims,
            UiCoverage::Unavailable,
        );
        drop(state_guard);

        assert_eq!(attribution.processes.len(), 2);
    }
}
