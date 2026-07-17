use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MethodMode {
    Stream,
    Unary,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RpcMethodSpec {
    pub name: &'static str,
    pub mode: MethodMode,
}

const fn unary(name: &'static str) -> RpcMethodSpec {
    RpcMethodSpec {
        name,
        mode: MethodMode::Unary,
    }
}

const fn stream(name: &'static str) -> RpcMethodSpec {
    RpcMethodSpec {
        name,
        mode: MethodMode::Stream,
    }
}

pub const ACTIVE_RPC_METHODS: &[RpcMethodSpec] = &[
    unary("assets.createUrl"),
    unary("cloud.getRelayClientStatus"),
    stream("cloud.installRelayClient"),
    unary("filesystem.browse"),
    unary("git.preparePullRequestThread"),
    unary("git.resolvePullRequest"),
    stream("git.runStackedAction"),
    unary("orchestration.dispatchCommand"),
    unary("orchestration.getArchivedShellSnapshot"),
    unary("orchestration.getFullThreadDiff"),
    unary("orchestration.getTurnDiff"),
    unary("orchestration.replayEvents"),
    stream("orchestration.subscribeShell"),
    stream("orchestration.subscribeThread"),
    unary("preview.close"),
    unary("preview.list"),
    unary("preview.navigate"),
    unary("preview.open"),
    unary("preview.refresh"),
    unary("preview.reportStatus"),
    unary("preview.resize"),
    stream("previewAutomation.connect"),
    unary("previewAutomation.focusHost"),
    unary("previewAutomation.respond"),
    unary("projects.createEntry"),
    unary("projects.deleteEntry"),
    unary("projects.duplicateEntry"),
    unary("projects.listEntries"),
    unary("projects.readFile"),
    unary("projects.renameEntry"),
    unary("projects.searchEntries"),
    unary("projects.writeFile"),
    unary("review.getDiffPreview"),
    unary("server.discoverSourceControl"),
    unary("server.getConfig"),
    unary("server.getProcessDiagnostics"),
    unary("server.getProcessResourceHistory"),
    unary("server.getProviderUsage"),
    unary("server.getSettings"),
    unary("server.getTraceDiagnostics"),
    unary("server.refreshProviders"),
    unary("server.refreshProviderUsage"),
    unary("server.removeKeybinding"),
    unary("server.signalProcess"),
    unary("server.updateProvider"),
    unary("server.updateSettings"),
    unary("server.upsertKeybinding"),
    unary("shell.openInEditor"),
    unary("sourceControl.cloneRepository"),
    unary("sourceControl.lookupRepository"),
    unary("sourceControl.publishRepository"),
    stream("subscribeAuthAccess"),
    stream("subscribeDiscoveredLocalServers"),
    stream("subscribePreviewEvents"),
    stream("subscribeServerConfig"),
    stream("subscribeServerLifecycle"),
    stream("subscribeTerminalEvents"),
    stream("subscribeTerminalMetadata"),
    stream("subscribeVcsStatus"),
    stream("terminal.attach"),
    unary("terminal.clear"),
    unary("terminal.close"),
    unary("terminal.open"),
    unary("terminal.resize"),
    unary("terminal.restart"),
    unary("terminal.write"),
    unary("vcs.clone"),
    unary("vcs.createRef"),
    unary("vcs.createWorktree"),
    unary("vcs.discardFiles"),
    unary("vcs.generateCommitMessage"),
    unary("vcs.init"),
    unary("vcs.listCommits"),
    unary("vcs.listRefs"),
    unary("vcs.pull"),
    unary("vcs.refreshStatus"),
    unary("vcs.removeWorktree"),
    unary("vcs.stageFiles"),
    unary("vcs.switchRef"),
    unary("vcs.unstageFiles"),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn method_spec_constructors_preserve_name_and_mode_at_runtime() {
        assert_eq!(
            unary("runtime.unary"),
            RpcMethodSpec {
                name: "runtime.unary",
                mode: MethodMode::Unary,
            }
        );
        assert_eq!(
            stream("runtime.stream"),
            RpcMethodSpec {
                name: "runtime.stream",
                mode: MethodMode::Stream,
            }
        );
    }
}
