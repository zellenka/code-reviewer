# AI Code Reviewer

[![CI](https://github.com/zellenka/code-reviewer/actions/workflows/ci.yml/badge.svg)](https://github.com/zellenka/code-reviewer/actions/workflows/ci.yml)

AI code review for your **local changes** in VS Code — staged, unstaged, branch vs base, current file or selection. Findings show up inline like a reviewer's comments, with one-click fixes.

Free and open source. **Bring your own model:** GitHub Copilot (no key needed) or your own Anthropic API key.

> **Status: early development.** Reviews run; findings show up inline as comment threads, in the Problems panel and in the AI Review view, with one-click fixes and a summary. Deeper context (an agent that reads related code) is next. See [implementation-plan.md](implementation-plan.md) for the roadmap.

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
3. Look at the findings:
   - **Inline comment threads** on the code, with buttons to apply or preview the fix, mark resolved, or dismiss.
   - The **AI Review** view in the Source Control sidebar: a summary of the change (walkthrough + top risks), findings grouped by file (click to jump to the code), and review details (model, tokens, cost, dropped findings).
   - The **Problems** panel: critical = error, major = warning, minor = info, nit = hint.
4. Fix: when a finding suggests a change, use the light bulb (**Apply fix** or **Preview fix…**) or the thread's buttons. Fixes are normal edits, so **Undo** works.
5. Keep editing: findings move with your code. If the code a finding refers to is changed or deleted, it's marked _outdated_ and its fix is disabled. **AI Review: Clear Findings** removes all findings.

Turn off the summary request with the `aiReview.summary` setting.

### Agentic reviews

By default each part of the diff is reviewed in one request (**single-pass**). In **agentic** mode the model can also look around the repository before reporting: read files, search the code, find references and look up the enclosing function. That catches bugs that only show up across files (a caller that no longer matches a changed signature, a constant in the wrong unit), at the cost of more requests and tokens. Turn it on for the repository with `review.mode: agentic` in `.codereview.yml`, or for yourself with the `aiReview.reviewMode` setting. The tools are read-only; limits per part are set by `aiReview.agent.maxTurns`, `aiReview.agent.maxToolCalls` and `aiReview.agent.tokenBudget`.

In both modes the model also gets the enclosing function or class of each change (from the language server when one is running), and for multi-file changes a list of the declarations changed across the diff (`aiReview.includeContext`). **Review Selection** sends only the selected lines (in agentic mode the model may still read other files).

### Repository rules

Write review guidelines in `.codereview.md` at the repository root (or point `rules:` in `.codereview.yml` at another file). `AGENTS.md` and `.github/copilot-instructions.md` are read too, when present. Breaking a rule is reported like any other finding. Rules can add things to check but can't turn off the reviewer's own rules.

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
rules: .codereview.md # review guidelines (AGENTS.md and .github/copilot-instructions.md are also read)
review:
  mode: single-pass # or agentic: the model may read other files in the repository
  categories: [bug, security, performance, maintainability, test] # add `style` to get style comments
```

The repository file decides _what_ is reviewed and reported. Your VS Code settings decide _how_ it runs (model, `aiReview.concurrency`, `aiReview.baseBranch`). The `aiReview.severityThreshold` and `aiReview.confidenceThreshold` settings can make the repository's thresholds stricter for you, never looser. An invalid file shows a warning and falls back to defaults for the invalid fields.

## Privacy

- **Your code goes only to the provider you pick** — GitHub Copilot or Anthropic — and is covered by that provider's data terms. There is no server of ours in between.
- **No telemetry.**
- Your Anthropic API key is stored in VS Code's encrypted Secret Storage, never in `settings.json`.
- Files that look like secrets (`.env*`, `*.pem`, `*.key`, `id_rsa*`, …), lockfiles and build output are never sent.
- Repository content is treated as untrusted. The reviewer can only read files inside the repository; it can't write files or run commands. In agentic mode the model chooses which files to read, but secret files and `.git/` are refused, and everything it reads is redacted like the diff.

### Data flow

When you run a review, this is exactly what happens:

1. The extension asks git for the diff of the scope you chose (in your repository, on your machine).
2. Files are filtered out **before anything leaves your machine**: secrets (`.env*`, `*.pem`, `*.key`, `*.p12`, `id_rsa*`, …), lockfiles, build output (`dist/`, `build/`, …), minified files, snapshots, generated files, binaries, deleted files, and anything in your `.codereview.yml` `ignore:` list.
3. In the remaining changes, known secret formats are replaced with `[REDACTED]`: cloud and API keys (AWS, GitHub, Anthropic, OpenAI, Slack, Google, Stripe, npm), private key blocks, JWTs, passwords in connection strings, and values assigned to names like `password`, `secret`, `token` or `api_key`. Turn on `aiReview.redactHighEntropyStrings` to also redact long random-looking strings.
4. The changed lines, the enclosing function or class of each change (redacted the same way), your repository rules files, and the review instructions are sent to the provider you selected — and nowhere else. In agentic mode, the files the model asks to read (same filtering and redaction) are sent too.
5. The model's findings come back and are shown in VS Code. Nothing is stored outside your machine by the extension.

Diff content is marked as untrusted data in the prompt, so instructions hidden in code or comments ("ignore previous instructions…") are not followed.

## Cost

- **Copilot:** nothing extra beyond your Copilot plan, but reviews count against its request limits. The extension shows how many requests a review uses.
- **Anthropic:** you pay Anthropic per token. Before each review the extension estimates the cost; if the upper estimate is above `aiReview.costConfirmationThreshold` (default $0.50) it asks you to confirm. The actual tokens and cost are shown after the review. Prompt caching lowers the cost of repeated context.
- The summary is one extra request per review; turn it off with `aiReview.summary`.
- Agentic reviews cost more: each part can use several requests, up to `aiReview.agent.tokenBudget` input tokens (default 200k). The cost estimate shows the range. Prompt caching makes the repeated parts of those requests much cheaper on Anthropic.
- Narrow the scope (staged changes, one file, a selection) to keep reviews cheap and fast.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).

## License

[Apache License 2.0](LICENSE)
