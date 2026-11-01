# AI Code Reviewer

[![CI](https://github.com/zellenka/code-reviewer/actions/workflows/ci.yml/badge.svg)](https://github.com/zellenka/code-reviewer/actions/workflows/ci.yml)

AI code review for your **local changes** in VS Code — staged, unstaged, branch vs base, current file or selection. Findings show up inline like a reviewer's comments, with one-click fixes.

Free and open source. **Bring your own model:** GitHub Copilot (no key needed) or your own Anthropic API key.

> **Status: early development (MVP).** Reviews run and findings show up in the Problems panel. Inline comment threads, one-click fixes and cost estimates are next. See [implementation-plan.md](implementation-plan.md) for the roadmap.

## Requirements

- VS Code 1.95 or newer (desktop). Cursor, Windsurf and vscode.dev are not supported.
- One of:
  - **GitHub Copilot** — uses the models your Copilot plan gives you, through VS Code's Language Model API.
  - **Anthropic API key** from the [Claude Console](https://console.anthropic.com/) (pay per token). Claude Pro/Max subscriptions can't be used by third-party tools.
- A **trusted** workspace (Workspace Trust). The extension is disabled in Restricted Mode.

## Usage

1. Pick a model: **AI Review: Select Model** (status bar). Copilot needs no setup; for Claude run **AI Review: Set Anthropic API Key** first.
2. Run one of:
   - **AI Review: Review Unstaged Changes** (includes new, untracked files)
   - **AI Review: Review Staged Changes**
   - **AI Review: Review Branch Changes** (everything since the branch left `main`; set `aiReview.baseBranch` to change the base)
   - **AI Review: Review Current File** / **Review Selection** (also in the editor's right-click menu)
3. Findings appear in the **Problems** panel: critical = error, major = warning, minor = info, nit = hint. **AI Review: Clear Findings** removes them.

## Configuration (`.codereview.yml`)

Commit a `.codereview.yml` at the repository root so everyone on the repo gets the same reviews. Every field is optional:

```yaml
version: 1
severityThreshold: minor # critical|major|minor|nit — findings below are hidden
confidenceThreshold: 0.6 # 0..1
onlyChangedLines: true # drop findings outside changed lines
ignore: # globs, added to the built-in ignores
  - '**/*.generated.ts'
  - 'docs/'
language: en # language of the review comments
review:
  categories: [bug, security, performance, maintainability, test] # add `style` to get style comments
```

The repository file decides _what_ is reviewed and reported. Your VS Code settings decide _how_ it runs (model, `aiReview.concurrency`, `aiReview.baseBranch`). The `aiReview.severityThreshold` and `aiReview.confidenceThreshold` settings can make the repository's thresholds stricter for you, never looser. An invalid file shows a warning and falls back to defaults for the invalid fields.

## Privacy

- **Your code goes only to the provider you pick** — GitHub Copilot or Anthropic — and is covered by that provider's data terms. There is no server of ours in between.
- **No telemetry.**
- Your Anthropic API key is stored in VS Code's encrypted Secret Storage, never in `settings.json`.
- Files that look like secrets (`.env*`, `*.pem`, `*.key`, `id_rsa*`, …), lockfiles and build output are never sent.
- Repository content is treated as untrusted. The reviewer can only read files inside the repository; it can't write files or run commands.

### Data flow

When you run a review, this is exactly what happens:

1. The extension asks git for the diff of the scope you chose (in your repository, on your machine).
2. Files are filtered out **before anything leaves your machine**: secrets (`.env*`, `*.pem`, `*.key`, `*.p12`, `id_rsa*`, …), lockfiles, build output (`dist/`, `build/`, …), minified files, snapshots, generated files, binaries, deleted files, and anything in your `.codereview.yml` `ignore:` list.
3. In the remaining changes, known secret formats are replaced with `[REDACTED]`: cloud and API keys (AWS, GitHub, Anthropic, OpenAI, Slack, Google, Stripe, npm), private key blocks, JWTs, passwords in connection strings, and values assigned to names like `password`, `secret`, `token` or `api_key`. Turn on `aiReview.redactHighEntropyStrings` to also redact long random-looking strings.
4. The changed lines, a few lines of context around them, and the review instructions are sent to the provider you selected — and nowhere else.
5. The model's findings come back and are shown in VS Code. Nothing is stored outside your machine by the extension.

Diff content is marked as untrusted data in the prompt, so instructions hidden in code or comments ("ignore previous instructions…") are not followed.

## Cost

- **Copilot:** nothing extra beyond your Copilot plan, but reviews count against its request limits. The extension shows how many requests a review uses.
- **Anthropic:** you pay Anthropic per token. Before large reviews the extension shows an estimate and asks you to confirm (default threshold $0.50, configurable). Prompt caching lowers the cost of repeated context.
- Narrow the scope (staged changes, one file, a selection) to keep reviews cheap and fast.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).

## License

[Apache License 2.0](LICENSE)
