# Codex prerequisites

- Install Codex CLI so `codex` is on your PATH.
- Authenticate Codex before running T4Code (for example via API key or ChatGPT auth supported by Codex).
- The native Rust provider runtime starts `codex app-server` as a supervised
  provider process for each Codex session. Node.js is not involved.
