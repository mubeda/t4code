mod attribution;
mod model;
mod monitor;
mod native;
mod registry;
mod trace;

pub use attribution::{
    AttributedProcess, AttributionConfidence, AttributionKind, AttributionScope,
    ProcessAttribution, ProcessAttributionTotals, ProcessClaim, ProcessResourceTotals,
    ResourceAttributor, UiCoverage,
};
pub use model::{
    DescendantEntry, PROCESS_CLAIM_LABEL_MAX_SCALARS, PROCESS_COMMAND_MAX_SCALARS,
    ProcessDiagnosticsResult, ProcessIdentity, ProcessResourceBucket, ProcessResourceHistory,
    ProcessResourceSummary, ProcessRow, ProcessSample, bound_diagnostic_string,
    build_descendant_entries, build_process_tree_entries,
};
pub use monitor::{DiagnosticsMonitor, ProcessSampler, SamplingError, SamplingLease};
pub use native::{NativeProcessSampler, ProcessSignal, SignalError};
pub use registry::{
    ProcessAttributionRegistry, ProcessRegistration, ProcessRegistrationMetadata,
    RegistrationSource,
};
pub use trace::TraceDiagnosticsStore;
pub(crate) use trace::redact_sensitive_text;
