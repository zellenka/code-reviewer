# AI Code Reviewer

AI code review for your **local changes** in VS Code — staged, unstaged, branch vs base, current file or selection. Findings show up inline like a reviewer's comments, with one-click fixes.

Free and open source. **Bring your own model:** GitHub Copilot (no key needed) or your own Anthropic API key.

> **Status: early development.** It can't review code yet; the sections below describe how it is designed to work. See [implementation-plan.md](implementation-plan.md) for the roadmap.

## Requirements

- VS Code 1.95 or newer (desktop). Cursor, Windsurf and vscode.dev are not supported.
- One of:
  - **GitHub Copilot** — uses the models your Copilot plan gives you, through VS Code's Language Model API.
  - **Anthropic API key** from the [Claude Console](https://console.anthropic.com/) (pay per token). Claude Pro/Max subscriptions can't be used by third-party tools.
- A **trusted** workspace (Workspace Trust). The extension is disabled in Restricted Mode.

## Privacy

- **Your code goes only to the provider you pick** — GitHub Copilot or Anthropic — and is covered by that provider's data terms. There is no server of ours in between.
- **No telemetry.**
- Your Anthropic API key is stored in VS Code's encrypted Secret Storage, never in `settings.json`.
- Files that look like secrets (`.env*`, `*.pem`, `*.key`, `id_rsa*`, …), lockfiles and build output are never sent.
- Repository content is treated as untrusted. The reviewer can only read files inside the repository; it can't write files or run commands.

## Cost

- **Copilot:** nothing extra beyond your Copilot plan, but reviews count against its request limits. The extension shows how many requests a review uses.
- **Anthropic:** you pay Anthropic per token. Before large reviews the extension shows an estimate and asks you to confirm (default threshold $0.50, configurable). Prompt caching lowers the cost of repeated context.
- Narrow the scope (staged changes, one file, a selection) to keep reviews cheap and fast.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).

## License

[Apache License 2.0](LICENSE)
