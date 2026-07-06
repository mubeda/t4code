# Source Control Integrations

T4Code connects directly to your Git hosting provider so you can create pull requests, review code, and manage repositories without leaving your editor. Work stays in flow without jumping between browser tabs and terminal windows.

## Supported Providers

T4Code works with the platforms your team already uses:

- **GitHub** – Pull requests, repository creation, and clone integration
- **GitLab** – Merge requests, repository publishing, and hosted clones
- **Bitbucket** – Pull request workflows (via API token authentication)
- **Azure DevOps** – Pull request support for Microsoft-hosted repositories

## What You Can Do

### Start Projects from Anywhere

**Clone repositories directly**

- Open the Command Palette (`Cmd/Ctrl + K`) → **Add Project**
- Choose **Clone from URL**
- Paste a Git URL, pick a destination folder and directory name, and start coding

**Import local repositories**

- Use the Add Project dialog's Local host flow to browse to a folder
- Select a Git repository directly, or choose a folder containing repositories
  and import multiple projects at once

**Publish local projects to the cloud**

- Have a local Git repository without a remote?
- Use the **Publish Repository** action to create a new hosted repository (GitHub, GitLab, Bitbucket, or Azure DevOps), add it as your origin remote, and push—all in one flow
- Perfect for turning a weekend prototype into a real project

### Manage Code Reviews Without Context Switching

**Create pull requests while you work**

- Push a branch and create a pull request from the Source Control panel
- T4Code can suggest titles and descriptions based on your commits
- Supports GitHub Pull Requests, GitLab Merge Requests, and Bitbucket Pull Requests

**Stay on top of open reviews**

- See if your current branch already has an open PR/MR
- Open the review directly in your browser with one click
- Check out a teammate's branch to review code locally

### Know Your Setup at a Glance

The **Source Control settings** page shows you exactly what's connected:

- ✅ Which providers are authenticated and ready
- ⚠️ What's missing and how to fix it
- 👤 Which account is signed in (when available)

Run a quick **Rescan** after setting up a new machine or changing credentials.

## Source Control Panel

The right-panel Source Control surface manages the active project/worktree:

- The primary button adapts to the repository state. It commits staged files by
  default, changes to Stage All Changes when nothing is staged, then exposes
  pull, push, publish, and PR states for clean-tree workflows.
- The dropdown stays visible and shows unavailable actions as disabled.
- Changes are grouped into Staged Changes, Changes, and Untracked Files with
  per-file status badges.
- Per-file hover actions stage, unstage, discard, restore deleted files, or
  delete untracked files. Destructive actions ask for confirmation.
- Row context menus are for navigation only: view, copy path, copy relative
  path, and open in an external editor.
- Commit history and AI commit-message generation are available in the panel.

There is intentionally no stash or amend action in this UI pass.

## Getting Started

### For GitHub (Recommended for most users)

1. Install the GitHub CLI on the machine running T4Code:
   ```bash
   brew install gh
   ```
2. Sign in:
   ```bash
   gh auth login
   ```
3. Open **Settings → Source Control** in T4Code and verify GitHub shows as authenticated

That's it—you can now clone, publish, and create pull requests.

### For GitLab

1. Install the GitLab CLI:
   ```bash
   brew install glab
   ```
2. Authenticate:
   ```bash
   glab auth login
   ```
3. Check **Settings → Source Control** to confirm the connection

### For Bitbucket

Bitbucket uses API tokens instead of a CLI tool:

1. Create an API token in your Atlassian account with read/write access to pull requests and repositories
2. Add these environment variables to the environment running T4Code:
   ```bash
   export T3CODE_BITBUCKET_EMAIL="you@example.com"
   export T3CODE_BITBUCKET_API_TOKEN="your-token"
   ```
3. Restart T4Code and verify the connection in **Source Control settings**

### For Azure DevOps

1. Install Azure CLI:
   ```bash
   brew install azure-cli
   ```
2. Add the DevOps extension:
   ```bash
   az extension add --name azure-devops
   ```
3. Sign in:
   ```bash
   az login
   ```

---

## Requirements & Troubleshooting

**Git is required** – T4Code uses Git for all local operations. Ensure `git` is installed on your server.

**Server-side setup** – Authentication happens on the machine running T4Code (the server), not your local browser. If you're using a hosted or team instance, your administrator may have already configured providers.

**Common issues:**

- **Provider shows "Not authenticated"** – Run the login command for that provider (e.g., `gh auth login`) in a terminal on the server, then rescan in Settings
- **Bitbucket not connecting** – Double-check your environment variables are set in the correct shell profile and the server was restarted
- **Can't push to a remote** – Verify your Git remote URL matches the provider you've authenticated with (SSH vs HTTPS remotes may need different credentials)

**Need more help?** Check your provider's CLI documentation:

- [GitHub CLI](https://cli.github.com/)
- [GitLab CLI](https://gitlab.com/gitlab-org/cli)
- [Azure CLI](https://docs.microsoft.com/en-us/cli/azure/)
