use serde_json::{Value, json};

use super::model::{
    SCOPE_ACCESS_READ, SCOPE_ORCHESTRATION_OPERATE, SCOPE_ORCHESTRATION_READ, SCOPE_RELAY_WRITE,
    SCOPE_REVIEW_WRITE, SCOPE_TERMINAL_OPERATE,
};

#[must_use]
pub(crate) fn required_scope(method: &str) -> Option<&'static str> {
    match method {
        "assets.createUrl"
        | "filesystem.browse"
        | "orchestration.getArchivedShellSnapshot"
        | "orchestration.getFullThreadDiff"
        | "orchestration.getTurnDiff"
        | "orchestration.replayEvents"
        | "orchestration.subscribeShell"
        | "orchestration.subscribeThread"
        | "preview.list"
        | "projects.listEntries"
        | "projects.readFile"
        | "projects.searchEntries"
        | "server.discoverSourceControl"
        | "server.getConfig"
        | "server.getProcessDiagnostics"
        | "server.getProcessResourceHistory"
        | "server.getProviderUsage"
        | "server.getSettings"
        | "server.getTraceDiagnostics"
        | "sourceControl.lookupRepository"
        | "subscribeDiscoveredLocalServers"
        | "subscribePreviewEvents"
        | "subscribeServerConfig"
        | "subscribeServerLifecycle"
        | "subscribeVcsStatus"
        | "vcs.listCommits"
        | "vcs.listRefs"
        | "vcs.refreshStatus" => Some(SCOPE_ORCHESTRATION_READ),
        "git.preparePullRequestThread"
        | "git.resolvePullRequest"
        | "git.runStackedAction"
        | "orchestration.dispatchCommand"
        | "preview.close"
        | "preview.navigate"
        | "preview.open"
        | "preview.refresh"
        | "preview.reportStatus"
        | "preview.resize"
        | "previewAutomation.connect"
        | "previewAutomation.focusHost"
        | "previewAutomation.respond"
        | "projects.createEntry"
        | "projects.deleteEntry"
        | "projects.duplicateEntry"
        | "projects.renameEntry"
        | "projects.writeFile"
        | "server.refreshProviders"
        | "server.refreshProviderUsage"
        | "server.removeKeybinding"
        | "server.signalProcess"
        | "server.updateProvider"
        | "server.updateSettings"
        | "server.upsertKeybinding"
        | "shell.openInEditor"
        | "sourceControl.cloneRepository"
        | "sourceControl.publishRepository"
        | "vcs.clone"
        | "vcs.createRef"
        | "vcs.createWorktree"
        | "vcs.discardFiles"
        | "vcs.generateCommitMessage"
        | "vcs.init"
        | "vcs.pull"
        | "vcs.removeWorktree"
        | "vcs.stageFiles"
        | "vcs.switchRef"
        | "vcs.unstageFiles" => Some(SCOPE_ORCHESTRATION_OPERATE),
        "terminal.attach"
        | "terminal.clear"
        | "terminal.close"
        | "terminal.open"
        | "terminal.resize"
        | "terminal.restart"
        | "terminal.write"
        | "subscribeTerminalEvents"
        | "subscribeTerminalMetadata" => Some(SCOPE_TERMINAL_OPERATE),
        "review.getDiffPreview" => Some(SCOPE_REVIEW_WRITE),
        "cloud.getRelayClientStatus" | "cloud.installRelayClient" => Some(SCOPE_RELAY_WRITE),
        "subscribeAuthAccess" => Some(SCOPE_ACCESS_READ),
        _ => None,
    }
}

#[must_use]
pub(crate) fn authorization_error(required_scope: &str) -> Value {
    json!({
        "_tag": "EnvironmentAuthorizationError",
        "message": format!(
            "The authenticated token is missing required scope: {required_scope}."
        ),
        "requiredScope": required_scope,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::ACTIVE_RPC_METHODS;

    #[test]
    fn every_active_rpc_method_has_exactly_one_declared_scope() {
        let missing = ACTIVE_RPC_METHODS
            .iter()
            .filter(|method| required_scope(method.name).is_none())
            .map(|method| method.name)
            .collect::<Vec<_>>();

        assert!(missing.is_empty(), "missing RPC scopes: {missing:?}");
        assert_eq!(
            required_scope("server.getConfig"),
            Some(SCOPE_ORCHESTRATION_READ)
        );
        assert_eq!(
            required_scope("server.updateSettings"),
            Some(SCOPE_ORCHESTRATION_OPERATE)
        );
        assert_eq!(
            required_scope("subscribeAuthAccess"),
            Some(SCOPE_ACCESS_READ)
        );
        assert_eq!(required_scope("unknown.method"), None);
    }
}
