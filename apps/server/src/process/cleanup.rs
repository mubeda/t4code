const MAX_REPORTED_FAILURES: usize = 8;
const MAX_FAILURE_SCALARS: usize = 160;

pub(crate) fn bound_process_cleanup_failure(failure: impl std::fmt::Display) -> String {
    failure
        .to_string()
        .chars()
        .take(MAX_FAILURE_SCALARS)
        .collect()
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct ProcessCleanupReport {
    pub(crate) attempted: usize,
    pub(crate) succeeded: usize,
    pub(crate) failure_count: usize,
    pub(crate) failures: Vec<String>,
}

impl ProcessCleanupReport {
    pub(crate) fn record_success(&mut self) {
        self.attempted = self.attempted.saturating_add(1);
        self.succeeded = self.succeeded.saturating_add(1);
    }

    pub(crate) fn record_failure(&mut self, failure: impl std::fmt::Display) {
        self.attempted = self.attempted.saturating_add(1);
        self.failure_count = self.failure_count.saturating_add(1);
        if self.failures.len() < MAX_REPORTED_FAILURES {
            self.failures.push(bound_process_cleanup_failure(failure));
        }
    }

    pub(crate) fn merge(&mut self, other: Self) {
        self.attempted = self.attempted.saturating_add(other.attempted);
        self.succeeded = self.succeeded.saturating_add(other.succeeded);
        self.failure_count = self.failure_count.saturating_add(other.failure_count);
        let remaining = MAX_REPORTED_FAILURES.saturating_sub(self.failures.len());
        self.failures
            .extend(other.failures.into_iter().take(remaining));
    }
}
