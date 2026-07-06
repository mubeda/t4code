# Runtime modes

T4Code exposes runtime mode controls in the chat toolbar for the session you are
composing into. In the center-panel UI, the host chat and each extra chat panel
own separate provider sessions, so a panel can carry its own session state even
though it shares the host worktree.

- **Full access** (default): starts sessions with `approvalPolicy: never` and `sandboxMode: danger-full-access`.
- **Supervised**: starts sessions with `approvalPolicy: on-request` and `sandboxMode: workspace-write`, then prompts in-app for command/file approvals.
