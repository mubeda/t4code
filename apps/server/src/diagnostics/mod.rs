mod attribution;
mod model;
mod monitor;
mod native;
mod trace;

pub use attribution::{
    AttributedProcess, AttributionConfidence, AttributionKind, AttributionScope,
    ProcessAttribution, ProcessAttributionTotals, ProcessClaim, ProcessResourceTotals,
    ResourceAttributor, UiCoverage,
};
pub use model::{
    DescendantEntry, ProcessDiagnosticsResult, ProcessIdentity, ProcessResourceBucket,
    ProcessResourceHistory, ProcessResourceSummary, ProcessRow, ProcessSample,
    build_descendant_entries, build_process_tree_entries,
};
pub use monitor::{DiagnosticsMonitor, ProcessSampler, SamplingError, SamplingLease};
pub use native::{NativeProcessSampler, ProcessSignal, SignalError};
pub use trace::TraceDiagnosticsStore;
pub(crate) use trace::redact_sensitive_text;
