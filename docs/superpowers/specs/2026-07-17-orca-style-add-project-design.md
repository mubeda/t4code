# Orca-Style Add Project Design

**Date:** 2026-07-17

**Status:** Approved in conversation

## Context

T4Code currently has two overlapping Add Project implementations:

- `AddProjectDialog` combines an embedded filesystem browser, nested-repository
  scanning and selection, clone controls, and project creation on one screen.
- `CommandPalette` retains an older environment-aware Add Project workflow for
  local, WSL, and remote environments.

Orca's newer Add Project interaction uses a compact launcher followed by
focused steps. The supplied Orca screenshots show:

1. An Add a project launcher with a host selector, Browse folder, Clone from
   URL, and Create new project.
2. A dedicated Clone from URL step.
3. A dedicated Create a new project step.

T4Code will adopt this interaction model and remove its current Add Project UI.

## Goals

- Make the Orca-style dialog the only Add Project UI.
- Support every currently connected T4Code environment through a Host selector.
- Use the native folder picker when the selected local or WSL environment can
  be routed safely.
- Use a focused host-path entry step for remote environments and browser-only
  sessions.
- Add an existing folder as one project.
- Clone a Git repository into a selected parent and register the clone.
- Create a directory, initialize it as a Git repository, and register it as a
  project through one server-side registration boundary.
- Open the resulting project's default workspace after a successful add, clone,
  or create.
- Preserve predictable behavior during failures and repeated dialog opens.

## Non-Goals

- No nested-repository scan, review, selection, or multi-import UI.
- No multi-folder picker.
- No visual remote filesystem browser; remote and browser-only paths are typed.
- No initial commit, README generation, template selection, or Git hosting
  provider setup for newly created projects.
- No provider-specific clone-source selection. Clone from URL accepts a Git URL.
- No host creation or connection-management UI inside Add Project.
- No deletion or redesign of the existing nested-repository backend
  capabilities.

## User Experience

### Launcher

The initial dialog follows the supplied Orca screenshot:

- Title: **Add a project**
- Host selector showing all currently connected environments
- Highlightable **Browse folder** action with the description
  "Local project, Git repo, or folder"
- **Other ways to add** section
- **Clone from URL** with the description "Clone a remote Git repository"
- **Create new project** with the description "Start from an empty folder"

The primary environment is selected whenever the dialog opens. Changing hosts
returns the dialog to the launcher and clears host-scoped draft values and
errors.

Browse receives initial focus. Tab, Arrow Up, and Arrow Down move focus between
the three actions. The focused action receives the highlighted treatment and
an Enter key hint. Enter activates it.

### Browse Folder

For the primary local environment and safely mapped desktop-local WSL
environments, Browse folder opens the existing native directory picker. WSL
picker routing continues to use the desktop pool instance identifier and strict
UNC-to-Linux path mapping already used by T4Code.

For a remote environment, or when no native desktop picker is available, Browse
folder opens a host-path step. The step contains:

- Back
- Title: **Open project folder**
- Description naming the selected host
- An editable absolute or home-relative host path
- A full-width **Open project** action

The selected folder is always registered as one project. T4Code does not scan
its children or offer nested imports in this UI.

### Clone From URL

The clone step contains:

- Back
- Title: **Clone from URL**
- Description: "Enter the Git URL and choose where to clone it."
- Git URL input
- Parent folder input
- A folder-picker button only when the selected environment can be routed to a
  native picker
- A full-width **Clone** action

The parent defaults to the selected environment's
`addProjectBaseDirectory`. An empty setting falls back to `~/`.

Enter submits when both fields are valid and no operation is pending.

### Create New Project

The create step contains:

- Back
- Title: **Create a new project**
- Description: "Name it and T4Code will create a real project with sensible
  defaults."
- Project name input
- A collapsed summary card reading **Git repository in \<parent\>**
- A target-path preview
- Expandable parent-location controls
- A full-width **Create project** action

The parent uses the same environment-scoped default as Clone from URL. The
project name is trimmed and must be one directory name: it cannot be empty,
`.` or `..`, or contain `/` or `\`.

Local and safely routed WSL environments can change the parent with the native
picker. Remote and browser-only environments use the editable parent field.

### Completion

On successful add, clone, or create:

1. Close the dialog.
2. Reuse an existing project when the normalized environment-and-path identity
   already exists.
3. Otherwise register the project.
4. Open or create its default thread/workspace using the existing navigation
   workflow.

## Architecture

### Dialog Ownership

`AddProjectDialog` is the sole owner of Add Project state. It is mounted once by
the top-level command surface and is opened by the sidebar, Command Palette,
menu, onboarding, and other existing Add Project intents.

Its explicit step state is:

```ts
type AddProjectStep = "start" | "host-path" | "clone" | "create";
```

The dialog is split into focused components:

- dialog chrome and back navigation
- host selector
- launcher actions
- host-path step
- clone step
- create step

A dedicated workflow hook owns environment selection, default paths, pending
state, project identity checks, environment-scoped commands, error reporting,
and completion navigation. Pure path, validation, and host-routing rules remain
separate from React so they can be tested without mounting the dialog.

### Existing-Folder Flow

Adding an existing folder dispatches `project.create` with:

- the selected environment
- a new project ID when no normalized duplicate exists
- a title inferred from the selected path
- `createWorkspaceRootIfMissing: false`
- `initializeGit: false`

Disabling directory creation ensures a missing or mistyped path fails instead
of silently creating a new folder.

### Clone Flow

Clone uses the existing environment-scoped `vcs.clone` operation with the Git
URL and selected parent directory. The returned clone path is passed to the
existing-folder registration flow. A clone that succeeds on disk but fails
during project registration remains retryable by browsing to or adding the
cloned folder.

### Create Flow

The `project.create` command gains an optional `initializeGit` boolean. Existing
callers retain current behavior because an omitted value decodes as false.

For the Create new project step, the client dispatches:

- `createWorkspaceRootIfMissing: true`
- `initializeGit: true`

The server normalizes and creates the workspace root, initializes Git in that
directory, and only then records the project creation event. A Git failure
therefore cannot expose a registered non-Git project. A failed attempt may
leave an empty directory on disk, which is safe to reuse on retry and is
reported clearly to the user.

This is intentionally a small extension to project creation rather than a new
general-purpose onboarding RPC.

### Host and Picker Routing

The Host selector is derived from the connected environment catalog. The
primary environment is selected on every fresh open.

Existing WSL picker routing and UNC mapping logic moves out of the legacy
Command Palette Add Project branch into reusable Add Project workflow helpers.
Picker availability is strict:

- Primary local desktop environment: native picker.
- Desktop-local WSL environment with a resolved pool instance: targeted native
  picker.
- Unresolved WSL, SSH, network remote, or browser-only environment: host-path
  entry.

The UI never sends a client-local picker result to an unrelated remote
environment.

## Failure and Concurrency Behavior

- Validation errors render inline and do not dispatch commands.
- Project, Git, clone, picker-routing, and navigation failures use the existing
  stacked error toast style with actionable messages.
- Interrupted atom commands do not produce duplicate error toasts.
- Back and close are available while editing and disabled during add, clone, or
  create mutations.
- Native picker cancellation returns to the launcher without an error.
- Each dialog open and host change advances a workflow generation. Results
  from an obsolete generation cannot close, navigate, or overwrite the current
  step's state.
- Submit actions are disabled while pending, preventing duplicate dispatch.
- A normalized duplicate project in the same environment is opened rather than
  registered again. Identical paths in different environments remain distinct.

## Removal Scope

The implementation removes:

- the embedded filesystem browser from `AddProjectDialog`
- child repository scanning and checkbox selection from `AddProjectDialog`
- nested-import controls and status copy from Add Project
- legacy Add Project browse, source-selection, and clone views in
  `CommandPalette`
- duplicate Add Project mutation and navigation logic owned by
  `CommandPalette`
- UI-only nested-repository detection helpers that become unused

The implementation preserves:

- generic filesystem browse RPCs used elsewhere
- nested-repository backend operations
- WSL picker routing and UNC mapping behavior, relocated behind the new
  workflow
- environment-scoped project, VCS, settings, and navigation infrastructure

User documentation and the Add Project base-directory setting description are
updated to describe the new launcher and picker/path behavior.

## Testing Strategy

Implementation follows strict red-green-refactor TDD.

### Contracts and Server

- Decode historical `project.create` commands without `initializeGit`.
- Decode new commands with `initializeGit: true`.
- Verify create-with-Git creates the directory, initializes `.git`, and records
  the project.
- Force Git initialization failure and verify no project creation event is
  recorded.
- Verify ordinary project creation remains unchanged.

### Pure Client Logic

- Build and select connected host options.
- Resolve environment-scoped parent defaults.
- Validate project names and host paths.
- Choose native picker versus host-path entry.
- Route WSL picker targets and UNC selections strictly.
- Detect normalized duplicates within one environment.
- Reset host-scoped step state on host changes and dialog reopen.

### Mounted React Behavior

- Render the launcher with the approved copy and without nested-import UI.
- Move the highlighted launcher action with Tab and arrow keys and activate it
  with Enter.
- Browse through the native local picker.
- Route WSL picks to the matching environment.
- Use host-path entry for remote and browser-only environments.
- Navigate Back from clone, create, and host-path steps.
- Clone and register the returned repository.
- Create a Git-initialized project.
- Keep failed steps open for retry.
- Disable dismissal and duplicate submission while pending.
- Open an existing duplicate rather than creating it.
- Open the resulting default workspace after success.

### Integration and Regression

- Every Add Project intent opens the new dialog.
- Command Palette no longer renders legacy Add Project browse or clone views.
- Existing project browsing outside Add Project remains unchanged.
- Final verification runs `vp check` and `vp run typecheck`.

## Success Criteria

- The dialog visually and behaviorally follows the supplied Orca screenshots.
- Local, WSL, and connected remote environments can be selected.
- Existing folders are added as one project without nested scanning UI.
- Clone from URL and Git-initialized project creation work on the selected
  environment.
- Successful operations open the resulting default workspace.
- Legacy Add Project UI and duplicate orchestration are removed.
- Nested-repository backend capabilities remain present.
- All targeted tests, `vp check`, and `vp run typecheck` pass.
