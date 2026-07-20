# Center Terminal Close Lifecycle Design

**Date:** 2026-07-19

## Summary

Closing a center-panel terminal currently removes only its persisted UI surface.
The server terminal session and provider CLI process remain alive, so the status
bar terminal count grows and the process continues after the tab disappears.

Every center-panel dismissal path must close the associated backend terminal
session before removing the surface:

- the close button in the center tab strip;
- the terminal panel's own **Close Terminal** control;
- **Close Others**;
- **Close to Right**;
- **Close All**.

Chat surfaces keep their existing close behavior.

## Root Cause

`ChatView` passes `centerPanelActions.closeSurface` and the other center-panel
store actions directly to `CenterPanelTabs` and `CenterTerminalPanel`. Those
actions update only `centerPanelStore`; they do not call the terminal close RPC,
remove terminal UI state, or release the terminal input scheduler.

The bottom terminal drawer and right-panel terminal surfaces already perform
those lifecycle operations before removing their UI state. Center terminals
must follow the same ownership pattern.

## Design

`ChatView` will own a focused center-surface cleanup callback. Given the center
surfaces about to be removed, it will:

1. ignore non-terminal surfaces;
2. remove each terminal from terminal UI state;
3. invoke `terminal.close` with `deleteHistory: true`;
4. release the terminal input scheduler when the close RPC succeeds.

Dedicated center-panel handlers will compute the surfaces removed by each
dismissal operation, invoke the cleanup callback, and then call the existing
`centerPanelStore` mutation:

- single close cleans the selected surface;
- close others cleans every surface except the selected surface;
- close to right cleans surfaces after the selected surface;
- close all cleans every surface.

The terminal panel's internal close control will use the same single-close
handler as the tab strip.

The Zustand store remains a pure persisted UI-state store. It will not gain RPC
or process-lifecycle dependencies.

## Error Handling

Surface removal remains immediate and optimistic, matching the existing
right-panel behavior. If `terminal.close` fails, the existing command error
handling records the failure; the UI does not restore a terminal surface whose
close was requested.

Scheduler resources are released only after a successful close response.
Duplicate terminal surfaces are not expected, but cleanup will operate on the
removed surface list and issue at most one close per terminal identifier in a
single dismissal operation.

## Testing

`ChatView.hooks.test.tsx` will reproduce the live failure before production code
changes:

- closing one center terminal removes the surface and sends one
  `terminal.close` request with `deleteHistory: true`;
- the terminal panel's internal close callback uses the same lifecycle path;
- close others, close to right, and close all close exactly the terminal
  sessions removed by each operation;
- closing chat-only center surfaces sends no terminal close request.

After the regression tests pass, the required repository checks will run:

- `vp test`;
- `vp check`;
- `vp run typecheck`.

The packaged macOS UI smoke test will then launch a provider terminal, close its
tab, and verify that the provider process exits and the terminal count returns
to its pre-launch value.

## Out of Scope

- Changing terminal shutdown semantics outside center panels.
- Refactoring all existing terminal cleanup code into a new cross-application
  abstraction.
- Changing center-panel persistence or provider command definitions.
