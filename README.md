# AI Code Reviewer

[![CI](https://github.com/zellenka/code-reviewer/actions/workflows/ci.yml/badge.svg)](https://github.com/zellenka/code-reviewer/actions/workflows/ci.yml)

AI code review for your **local changes** in VS Code — staged, unstaged, branch vs base, current file or selection. Findings show up inline like a reviewer's comments, with one-click fixes.

Free and open source. **Bring your own model:** GitHub Copilot (no key needed) or your own Anthropic API key.

> **Status: early development.** Reviews run in single-pass or agentic mode; findings show up inline as comment threads, in the Problems panel and in the AI Review view, with one-click fixes and a summary. Re-reviews only send what changed, and dismissed findings stay dismissed. A CLI and GitHub Action are next. See [implementation-plan.md](implementation-plan.md) for the roadmap.

## Requirements

- VS Code 1.95 or newer (desktop). Cursor, Windsurf and vscode.dev are not supported.
- One of:
  - **GitHub Copilot** — uses the models your Copilot plan gives you, through VS Code's Language Model API.
  - **Anthropic API key** from the [Claude Console](https://console.anthropic.com/) (pay per token). Claude Pro/Max subscriptions can't be used by third-party tools.
- A **trusted** workspace (Workspace Trust). The extension is disabled in Restricted Mode.

## Usage

1. Click the **AI Review** icon in the Activity Bar (left side). The **Review** panel lets you:
   - choose what to review: unstaged changes, staged changes, branch changes (with a base branch picker), one or more commits, the current file or the selection;
   - pick the repository (when the workspace has several), the model, the review mode, whether to include surrounding code and whether to double-check findings;
   - press **Run Review** (or **Cancel Review** while it runs). Your choices are remembered per workspace.

   Copilot needs no setup; for Claude press **Set API Key** in the panel (or run **AI Review: Set Anthropic API Key**).

2. Or use the commands:
   - **AI Review: Run Review** (uses the panel's choices) / **AI Review: Open Review Panel**
   - **AI Review: Review Unstaged Changes** (new, untracked files only if you say so: before anything is sent, it lists them and asks whether to review with or without them, every time)
   - **AI Review: Review Staged Changes**
   - **AI Review: Review Branch Changes** (everything since the branch left `main`, committed or not, in files git tracks; untracked files are never included; set `aiReview.baseBranch` to change the base)
   - **AI Review: Review Commits…**: pick one or more commits of the current branch from a list; they are reviewed together as committed, from the oldest to the newest (picking commits that aren't next to each other reviews the ones between them too, and asks first). Findings are shown on your working tree; one on code that changed since is marked _outdated_. A keybinding can name the commits: `{ "toCommit": "HEAD" }` reviews the last commit, `fromCommit` sets the oldest.
   - **AI Review: Review Current File** / **Review Selection** (also in the editor's right-click menu; a file git ignores, or one outside a git repository, is refused)
3. Look at the findings:
   - **Inline comment threads** on the code, with buttons to apply or preview the fix, mark resolved, or dismiss.
   - The **Findings** view in the AI Review sidebar, below the panel: a summary of the change (walkthrough + top risks), findings grouped by file (click to jump to the code), and review details (model, tokens, cost, dropped findings).
   - The **Problems** panel: critical = error, major = warning, minor = info, nit = hint.
   - **Save Review as Markdown** (Findings view title, the panel, or the command palette): writes the summary, the open findings by file with their code and suggested fixes, and the review details to `review-summary-<date>.md` in the repository root, and opens it. Saving the same review again updates that file; another review the same day gets `review-summary-<date>-2.md`.
   - **Send Review to Agent Chat** (same places) and **Send to Agent Chat** on a finding (in the Findings view and its comment thread): types a prompt into Claude Code or GitHub Copilot Chat (agent mode) asking it to check the finding(s) and fix the real ones. The prompt is typed in, not sent, so you can edit it first. `aiReview.agentChat` picks the chat; by default the one installed is used, and when both are you're asked.
4. Fix: when a finding suggests a change, use the light bulb (**Apply fix** or **Preview fix…**) or the thread's buttons. Fixes are normal edits, so **Undo** works.
5. Keep editing: findings move with your code. If the code a finding refers to is changed or deleted, it's marked _outdated_ and its fix is disabled. **AI Review: Clear Findings** removes all findings.
6. Review again after your edits: only the changes since the last review are sent (see below). Findings you dismissed or resolved stay that way in later reviews, even when the model words them a little differently; **AI Review: Forget Dismissed and Resolved Findings** brings them back.

Turn off the summary request with the `aiReview.summary` setting.

### Re-reviews and double-checking

**Incremental re-reviews.** When you review the same scope again (unstaged, staged, branch, the same commits or a file), only the hunks that changed since the last complete review are sent. Findings on code you didn't touch are kept and moved to their current lines. Everything is sent again when the model, review mode, settings or repository rules changed, and after **Clear Findings**. A cancelled or partly failed review doesn't replace the last complete one. Unchanged hunks aren't checked again against changes elsewhere, so after larger refactors run **Clear Findings** for a full review. Turn it off with `aiReview.incrementalReview`.

**Double-check findings (verify pass).** Optionally, after the review the model is asked once more, per file, whether each finding is a real issue; rejected findings are dropped (and counted under "dropped" in the review details). This trades one extra request per file with findings for fewer false positives. It is off by default; turn it on for the repository with `review.verify: true` in `.codereview.yml`, or for yourself with `aiReview.verifyFindings` (or the panel's **Double-check findings** box, which also shows when the repository config turned it on). Findings you dismiss or resolve stay that way when a later review reports them again.

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
ignore: # globs for generated, vendored and lock files, added to the built-in ignores
  - '**/*.generated.ts'
  - 'vendor/'
language: en # language of the review comments: a name or tag such as en, pt-BR or Simplified Chinese
rules: .codereview.md # review guidelines (AGENTS.md and .github/copilot-instructions.md are also read)
review:
  mode: single-pass # or agentic: the model may read other files in the repository
  categories: [bug, security, performance, maintainability, test] # add `style` to get style comments
  verify: false # true: double-check each finding with one extra request per file
```

The repository file decides _what_ is reviewed and reported, but it can only tighten a review: it may add scrutiny freely (lower thresholds, more categories, agentic mode, the verify pass), while what would make the review see less is not applied, and the review result says what wasn't: thresholds higher than the defaults (or your own), turned-off default categories, and `ignore:` patterns that match ordinary source files. `ignore:` does skip generated, vendored and lock files: build output, minified files, snapshots, `vendor/`, `generated/` and `__generated__/` directories, `*.generated.*`, protobuf output (`*.pb.go`, `*_pb2.py`, …) and files marked generated in their header. For repositories you trust, turn on `aiReview.allowRepoConfigToRelax` (user settings only, for every repository): the file is then applied in full, and the review result still names what it turned down. A file that turns off every category is always refused. Your VS Code settings decide _how_ it runs (model, mode, verify pass, …). The `aiReview.severityThreshold` and `aiReview.confidenceThreshold` settings can make the repository's thresholds stricter for you, never looser. An invalid file shows a warning and falls back to defaults for the invalid fields. The file and the rules files are read from your working tree, so a change that edits them also changes its own review: the review result then says so, and you should check those edits yourself. Since the file can only add scrutiny, a branch that edits it can't weaken its own review, so it isn't read from the base branch.

## Privacy

- **Your code goes only to the provider you pick** — GitHub Copilot or Anthropic — and is covered by that provider's data terms. There is no server of ours in between.
- **No telemetry.**
- Your Anthropic API key is stored in VS Code's encrypted Secret Storage, never in `settings.json`.
- Files that look like secrets (`.env*`, `*.pem`, `*.key`, `id_rsa*`, …), lockfiles and build output are never sent. Neither are files git ignores, nor untracked files unless you confirm them for an unstaged review, nor files excluded from AI review (see [Excluded files](#excluded-files)).
- **Save Review as Markdown** and **Send to Agent Chat** quote code as the reviewer saw it: secrets stay `[REDACTED]`, and excluded files never have findings. Sending to a chat hands the findings, their code and the summary to that chat's model, under its own terms.
- Repository content is treated as untrusted. The reviewer can only read files inside the repository; it can't write files or run commands. In agentic mode the model chooses which files to read, but secret files and `.git/` are refused, and everything it reads is redacted like the diff.

### Excluded files

A GitHub organization can set Copilot content exclusion: files Copilot must never be sent. VS Code doesn't apply it to other extensions, so AI Review applies it itself, with either provider (Copilot or Anthropic), in two ways:

- **`aiReview.excludeFiles`** (user settings only): globs of files never to send. It works in any VS Code; copy your organization's excluded paths into it, e.g. `"aiReview.excludeFiles": ["/scripts/**", "secrets.json", "*.cfg"]`. A leading `/` means the repository root, a pattern without `/` matches a name in any folder, a matched folder excludes everything in it, and letter case is ignored.
- **Copilot's own content exclusion** (the organization's rules and `.copilotignore`), asked through VS Code's `vscode.lm.fileIsIgnored`. That API is still a _proposed_ API, which stable VS Code only lets an extension use when you enable it: run **Preferences: Configure Runtime Arguments**, add `"enable-proposed-api": ["serhii.ai-code-reviewer"]` to `argv.json`, and restart VS Code. It also needs GitHub Copilot Chat installed and signed in.

A file either one excludes is skipped as `excluded`: not its content, not its name (the model is only told how many were left out), not its search hits or references in agentic mode, and not as a rules file. **Review Current File** and **Review Selection** refuse it and send nothing. When the Copilot check can't run (the API isn't enabled, Copilot Chat isn't running, or asking it fails), the review still runs with `aiReview.excludeFiles` applied, and its result warns, once, that Copilot content exclusion was not checked, why, and how to enable it.

### Data flow

When you run a review, this is exactly what happens:

1. The extension asks git for the diff of the scope you chose (in your repository, on your machine). Untracked files (new files git doesn't track yet, such as notes or a database dump) are only part of an unstaged review, and only when you choose **Review with Them** in the question that lists them; otherwise they are listed as skipped (`untracked`) for you, while the model isn't even told their names (the summary request only counts them), and in agentic mode it can't read them either. Branch and commit reviews never include them (a commit review reads the commits from git, not your working tree). **Review Current File** and **Review Selection** refuse a file git ignores (a local config, say) and send nothing.
2. Files excluded from AI review (`aiReview.excludeFiles`, and Copilot content exclusion when the check can run) are taken out, and only counted for the model. Then files are filtered out **before anything leaves your machine**: secrets (`.env*`, `*.pem`, `*.key`, `*.p12`, `id_rsa*`, and credential files such as `.aws/credentials`, kubeconfig, `credentials.json`, Terraform `*.tfvars` and state, `appsettings.<Environment>.json` and `local.settings.json`, …), lockfiles, build output (`dist/`, `build/`, …), minified files, snapshots, generated files, binaries, deleted files, and the generated, vendored and lock files your `.codereview.yml` `ignore:` list names (any file it names, with `aiReview.allowRepoConfigToRelax`).
3. In the remaining changes, known secret formats are replaced with `[REDACTED]`: cloud and API keys (AWS, GitHub, Anthropic, OpenAI, Slack, Google, Stripe, npm), private key blocks, JWTs, passwords in connection strings, and values assigned to names like `password`, `secret`, `token` or `api_key` (also in XML elements and attributes, .NET `<add key=… value=…>` settings and PHP `define(…)` and arrays). Turn on `aiReview.redactHighEntropyStrings` to also redact long random-looking strings.
4. The changed lines, the enclosing function or class of each change (redacted the same way), your repository rules files, and the review instructions are sent to the provider you selected — and nowhere else. In agentic mode, the files the model asks to read (same filtering and redaction) are sent too.
5. The model's findings come back and are shown in VS Code. Nothing is stored outside your machine by the extension. In VS Code's local workspace storage it keeps the last review per scope (findings and hashes of the reviewed changes, for incremental re-reviews) and which findings you dismissed or resolved. Code with secrets in it is stored there redacted, as it was sent.

Diff content is marked as untrusted data in the prompt, so instructions hidden in code or comments ("ignore previous instructions…") are not followed.

## Cost

- **Copilot:** nothing extra beyond your Copilot plan, but reviews count against its request limits. The extension shows how many requests a review uses.
- **Anthropic:** you pay Anthropic per token. Before each review the extension estimates the cost; if the upper estimate is above `aiReview.costConfirmationThreshold` (default $0.50) it asks you to confirm. The actual tokens and cost are shown after the review. Prompt caching lowers the cost of repeated context.
- The summary is one extra request per review; turn it off with `aiReview.summary`.
- Re-reviewing the same scope only sends what changed since the last review, so a review after a small fix is cheap.
- The verify pass (off by default) adds up to one request per file with findings; the cost estimate includes it in the upper bound.
- Agentic reviews cost more: each part can use several requests, up to `aiReview.agent.tokenBudget` input tokens (default 200k, at most 2M). The cost estimate shows the range. Prompt caching makes the repeated parts of those requests much cheaper on Anthropic.
- Settings that change what a review costs, how closely it looks or where your code is sent (`aiReview.provider`, `aiReview.model`, `aiReview.costConfirmationThreshold`, `aiReview.anthropic.*`, `aiReview.excludeFiles`, `aiReview.agent.*`, `aiReview.reviewMode`, `aiReview.verifyFindings`, `aiReview.summary`, the thresholds, …) are read from your user settings only, so a repository's `.vscode/settings.json` can't change them. Only `aiReview.baseBranch` and `aiReview.concurrency` may come from the workspace.
- Narrow the scope (staged changes, one file, a selection) to keep reviews cheap and fast.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).

## License

[Apache License 2.0](LICENSE)
