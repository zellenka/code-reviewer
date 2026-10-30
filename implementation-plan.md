# AI Code Reviewer — Implementation Plan

VS Code extension for AI code review (CodeRabbit-like), later also a CI/PR bot. Free & open source, bring-your-own-key.

## Progress

- [x] **Phase 0 — Repo foundation** (P0-1, P0-2, P0-3) — done 2026-10-30 ([#1](https://github.com/zellenka/code-reviewer/pull/1), [#2](https://github.com/zellenka/code-reviewer/pull/2))
- [ ] **Phase 1 — Providers** (P1-1, P1-2, P1-3, P1-4a, P1-4b)
- [ ] **Phase 2 — Single-pass review (MVP)** (P2-0 … P2-10)
- [ ] **Phase 3 — Real review UX** (P3-1 … P3-6)
- [ ] **Phase 4 — Context & agent loop** (P4-1 … P4-6)
- [ ] **Phase 5 — Quality & state** (P5-1 … P5-4)
- [ ] **Phase 6 — CI / PR bot** (P6-1 … P6-4)
- [ ] **Phase 7 — Release** (P7-1, P7-2)

## Decisions

| Topic | Decision |
|---|---|
| v1 review target | Local changes only: unstaged (incl. untracked files), staged, branch vs base, current file, selection. PRs later. |
| End goal | IDE extension **and** CI/PR bot sharing one review engine. Candidate for team/company adoption. |
| Providers | **GitHub Copilot** via VS Code Language Model API (`vscode.lm`, no key). **Anthropic** via API key (Claude Console, pay-per-token). Claude Pro/Max subscription login is **not allowed** for third-party tools — API key only. |
| Editors | VS Code desktop only. Cursor/Windsurf not supported (no `vscode.lm` there). No web extension (vscode.dev) — needs git + fs. |
| Agent approach | Own thin, bounded agent loop over a shared `LLMProvider` interface. **Not** the Claude Agent SDK (Claude-only, spawns a bundled native binary, can't drive Copilot). |
| Structured output | Model returns findings via a forced `report_findings` tool call (schema-shaped). Free-text JSON parsing is a fallback only. |
| Business model | Free/OSS, BYOK. No backend, no telemetry by default. |
| License | Apache-2.0 (patent grant eases company legal review). |

### Implications of these decisions
- **Core must not import `vscode`.** The same engine runs in the extension, a CLI, evals and a GitHub Action.
- **CI can't use Copilot.** `vscode.lm` only exists inside VS Code, so CI and evals run on the Anthropic API key (more providers can be added later through the same interface).
- **Team adoption** needs shared, committed config (rules file, ignore list, severity threshold) so everyone on a repo gets the same reviews — and a clear privacy statement (code goes only to the provider the user picked).
- **Repo content is untrusted.** Diffs, rules files and `AGENTS.md` can contain prompt injection. Tools are read-only and sandboxed; the extension requires Workspace Trust.
- **OSS hygiene from day one:** license, CONTRIBUTING, CI for the repo itself, publish to VS Code Marketplace + Open VSX.

## Architecture

```
repo/
  packages/
    core/       # pure TS: diff parse → chunk → context → review → validate → findings
    node-host/  # Node implementations: git-CLI DiffSource, fs WorkspaceTools (used by evals, CLI, Action)
    vscode/     # extension: commands, UI, VsCodeLmProvider, git via built-in Git API
    cli/        # (phase 6) node CLI + GitHub Action wrapper
  evals/        # fixture diffs with expected findings + runner
```

```
┌─ packages/vscode (thin) ──────────────────────────────┐
│ Commands · SecretStorage · Comments API · Diagnostics  │
│ CodeActions (apply fix) · Summary view · Status bar    │
│ VsCodeLmProvider · VsCodeWorkspaceTools (LSP-backed)   │
│ VsCodeDiffSource (Git ext API) · Logger (OutputChannel)│
└──────────────┬────────────────────────────────────────┘
┌─ packages/core ───────────────────────────────────────┐
│ DiffParser → Chunker → ContextBuilder → Reviewer       │
│   → FindingValidator (zod + re-anchor) → Findings[]    │
│ Summarizer · AgentLoop (bounded) · Tool interface      │
│ LLMProvider interface · AnthropicProvider              │
│ Config loader (.codereview.yml + rules .md)            │
└───────────────────────────────────────────────────────┘
```

Build: esbuild bundles `core` into the extension (`vscode` external). Versioning via changesets.

### Conventions (apply everywhere)
- **Lines:** all core types use **1-based, inclusive** line numbers (same as unified diff). Conversion to VS Code's 0-based `Position`/`Range` happens only in `packages/vscode`.
- **Paths:** core uses repo-root-relative POSIX paths (`src/a.ts`). Hosts convert to/from absolute OS paths. On Windows, compare paths case-insensitively for the drive letter.
- **Line endings:** diff text and file content are normalized to `\n` before chunking, quote matching and hashing. When applying a fix, the file's original EOL is preserved.
- **Source of truth per mode:** the reviewed content is the *new side* of the diff — index for `staged`, working tree for `unstaged`/`file`/`selection`, working tree for `branch` (merge-base…working tree). Findings are re-anchored by `quote` against the *working-tree document* for display; if the quote can't be found there, the finding is shown as **stale** (dimmed, no fix action).
- **Finding fingerprint:** `id = sha1(file + "\n" + category + "\n" + normalize(quote))`, where `normalize` collapses whitespace. Title is **not** part of the id (LLM wording varies). Dismissed-state matching falls back to fuzzy compare (same file + category, quote similarity ≥ 0.85).
- **Logging:** `Logger` interface in core; VS Code implements it with an OutputChannel. Levels `error|warn|info|debug|trace`. Code content and prompts are logged only at `trace`; API keys never.

### Key interfaces

```ts
// ---------- Provider ----------
interface ModelInfo {
  id: string; name: string; vendor: string;
  maxInputTokens: number; maxOutputTokens: number;
  supportsTools: boolean;
  pricing?: { inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok?: number; cacheWritePerMTok?: number };
}

type Message =
  | { role: 'user'; content: ContentPart[] }
  | { role: 'assistant'; content: ContentPart[] };
type ContentPart =
  | { type: 'text'; text: string; cache?: boolean }          // cache = provider-agnostic cache breakpoint hint
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; callId: string; content: string; isError?: boolean };

interface ToolDef { name: string; description: string; inputSchema: JSONSchema }

interface ChatRequest {
  model: string;
  system: { text: string; cache?: boolean }[];
  messages: Message[];
  tools?: ToolDef[];
  toolChoice?: 'auto' | 'none' | { name: string };          // forced tool for report_findings
  maxOutputTokens?: number;
  temperature?: number;                                     // default 0
  signal: AbortSignal;
}

type ChatEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'usage'; usage: Usage }
  | { type: 'stop'; reason: 'end' | 'tool_use' | 'max_tokens' | 'cancelled' };

interface Usage { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; requests: number }

class ProviderError extends Error {
  kind: 'auth' | 'consent' | 'rateLimit' | 'quota' | 'contextTooLong' | 'blocked' | 'network' | 'unknown';
  retryable: boolean; retryAfterMs?: number;
}

interface LLMProvider {
  id: 'copilot' | 'anthropic' | string;
  listModels(): Promise<ModelInfo[]>;
  chat(req: ChatRequest): AsyncIterable<ChatEvent>;
  countTokens(model: string, text: string): Promise<number>; // Anthropic: local heuristic (chars/3.5); vscode.lm: model.countTokens
}

// ---------- Diff ----------
interface UnifiedDiff { files: FileDiff[] }
interface FileDiff {
  path: string; oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  binary: boolean;
  hunks: Hunk[];
  newContent?: string;        // full new-side content (for context + re-anchoring)
}
interface Hunk {
  oldStart: number; oldLines: number; newStart: number; newLines: number;
  lines: { kind: 'add' | 'del' | 'ctx'; text: string; oldLine?: number; newLine?: number }[];
}
interface DiffSource {           // implemented per host; core only parses
  getDiff(mode: ReviewMode): Promise<UnifiedDiff>;
}
type ReviewMode =
  | { kind: 'unstaged' } | { kind: 'staged' }
  | { kind: 'branch'; base?: string }          // diff from merge-base(base, HEAD) to working tree
  | { kind: 'file'; path: string }
  | { kind: 'selection'; path: string; startLine: number; endLine: number };

// ---------- Workspace tools ----------
interface WorkspaceTools {           // implemented per host; all read-only, sandboxed to repo root
  readFile(path: string, range?: { start: number; end: number }): Promise<string>;
  grep(pattern: string, glob?: string): Promise<{ path: string; line: number; text: string }[]>;
  findReferences(path: string, line: number, col: number): Promise<{ path: string; line: number }[]>; // LSP in VS Code, grep fallback in node-host
  getSymbolAt(path: string, line: number): Promise<{ name: string; kind: string; startLine: number; endLine: number } | null>;
}

// ---------- Findings ----------
interface Finding {
  id: string;            // fingerprint, see Conventions
  file: string;
  startLine: number; endLine: number;   // 1-based, inclusive, new side
  anchor: 'line' | 'file';              // 'file' = whole-file finding (e.g. missing tests), shown at line 1
  severity: 'critical' | 'major' | 'minor' | 'nit';
  category: 'bug' | 'security' | 'performance' | 'maintainability' | 'style' | 'test';
  title: string;
  body: string;          // markdown
  quote: string;         // exact new-side code the finding refers to; may be multi-line.
                         // For deleted code: quote the nearest surrounding new-side line and say so in body.
  suggestion?: string;   // replacement code for quote
  confidence: number;    // 0..1
  stale?: boolean;       // set by host when quote no longer found in the working tree
}

interface ReviewResult { findings: Finding[]; summary?: string; usage: Usage; dropped: { reason: string; count: number }[] }
```

### `.codereview.yml` schema (P2-0)

```yaml
version: 1
severityThreshold: minor        # critical|major|minor|nit — findings below are hidden. Default: minor
confidenceThreshold: 0.6        # 0..1. Default: 0.6
onlyChangedLines: true          # drop findings outside changed lines. Default: true
ignore:                         # globs, added to built-in defaults
  - "**/*.generated.ts"
rules: .codereview.md           # rules markdown path. Also auto-read: AGENTS.md, .github/copilot-instructions.md
language: en                    # language of review comments (not the code language). Default: en
review:
  mode: single-pass             # single-pass|agentic. Default: single-pass
  categories: [bug, security, performance, maintainability, test]   # style off by default
```

**Precedence:** the repo file controls *what* is reviewed and reported (ignore, rules, thresholds, categories, language). User/VS Code settings control *how* it runs (provider, model, concurrency, cost threshold, log level). A user setting may make thresholds stricter, never looser. Invalid config → warning notification + defaults, never a crash.

## Phases & tasks

Each task: **ID · title** — description. *AC* = acceptance criteria. *Deps* = blocking tasks.
**Test types:** *unit* (mock provider, deterministic, every PR), *ext* (`@vscode/test-electron`, every PR), *live* (real provider, needs secret, run on demand/nightly — never required for PR CI because fork PRs get no secrets).

### Phase 0 — Repo foundation ✅ Done
- **P0-1 · Monorepo scaffold** — pnpm workspaces (pin pnpm + Node LTS in `packageManager`/`.nvmrc`), TypeScript project refs, ESLint/Prettier, Vitest, esbuild bundling for the extension, changesets. *AC:* `pnpm build` and `pnpm test` pass from root; `core` has a lint rule forbidding `vscode` imports.
- **P0-2 · Extension scaffold** — `packages/vscode` with activation on command; set extension id/publisher, `aiReview.*` command and settings namespace; `engines.vscode` = lowest version with stable `vscode.lm` tool calling (verify exact version); `capabilities.untrustedWorkspaces: { supported: false }`; Logger on an OutputChannel. F5 debug works. *AC:* "AI Review: Hello" command runs in Extension Development Host. *Deps:* P0-1
- **P0-3 · OSS basics + CI** — LICENSE (Apache-2.0), README (privacy + cost section), CONTRIBUTING, issue templates, GitHub Actions running lint, unit and ext tests (xvfb on Linux) on PRs; separate manually-triggered workflow for live tests. *AC:* CI green on a sample PR; ext test launches VS Code headless. *Deps:* P0-2

### Phase 1 — Providers
- **P1-1 · `LLMProvider` interface + mock provider** — types from *Key interfaces*, `ProviderError` taxonomy, scripted mock for tests. *AC:* mock can replay text + tool-call sequences and throw each `ProviderError` kind; unit tests cover it. *Deps:* P0-1
- **P1-2 · AnthropicProvider** — `@anthropic-ai/sdk`, streaming, tool use incl. forced `toolChoice`, maps `cache` hints to `cache_control`, usage reporting, retry with backoff on 429/5xx (respect `retry-after`), maps errors to `ProviderError`. Model list + pricing from a hardcoded table, overridable in settings. *AC:* live test completes a tool-call round trip and reports usage; unit tests cover error mapping. *Deps:* P1-1
- **P1-3 · VsCodeLmProvider** — wraps `vscode.lm.selectChatModels({vendor:'copilot'})`, maps tool calls, maps `LanguageModelError` (no consent, quota, blocked) to `ProviderError`, first call only from a user command. Ignores `cache` hints. *AC:* a chat round trip with one tool call succeeds with a Copilot model; denied consent shows a clear message, not a stack trace. *Deps:* P1-1, P0-2
- **P1-4a · Provider & model picker** — quick pick + status bar item, stored in settings; switching takes effect without reload. *AC:* choosing a Copilot model is used by the next request (ext test with a stubbed provider). *Deps:* P1-3
- **P1-4b · Anthropic key storage** — key in `SecretStorage` with "Set/Clear API key" commands, never in settings.json; Anthropic appears in the picker when a key is set. *AC:* key survives reload, isn't in any settings file; `auth` error offers "Set API key". *Deps:* P1-2, P1-4a

### Phase 2 — Single-pass review (MVP)
- **P2-0 · Config schema & loader** — zod schema for `.codereview.yml` (see above), defaults, precedence with settings, file watcher reload. *AC:* unit tests for defaults, invalid file (warning + defaults), precedence rules. *Deps:* P0-1
- **P2-1 · DiffSource + parser** — core: unified-diff parser → `UnifiedDiff` (CRLF normalized). VS Code: `VsCodeDiffSource` via built-in Git extension API for all `ReviewMode`s; untracked files included in `unstaged`; base auto-detected (`origin/HEAD` → `main` → `master`, overridable), diff from merge-base. Multi-repo workspace: review the repo of the active editor, else ask. No repo / detached HEAD → clear message. *AC:* parser fixtures for add/modify/delete/rename/binary/CRLF/no-newline-at-EOF parse correctly; ext test produces a diff for each mode on a temp repo. *Deps:* P0-2
- **P2-2 · Ignore & filter** — built-in ignores: lockfiles, `dist/`, `build/`, minified, snapshots, `@generated` markers, binaries, **secrets** (`.env*`, `*.pem`, `*.key`, `*.p12`, `id_rsa*`), plus config `ignore:`. Deleted files are listed in the summary but not reviewed. *AC:* ignored files never reach the provider (asserted with mock provider). *Deps:* P2-0, P2-1
- **P2-3 · Chunker + token budget** — per-file chunks, split large files by hunk groups, merge small files; budget = `maxInputTokens` − system prompt − rules − output reserve. Oversize → "too large, narrow the scope" message. *AC:* no request exceeds the model's input limit in tests with a 5k-line diff. *Deps:* P2-1, P1-1
- **P2-4 · Review prompt + structured output** — system prompt (role, severity rubric with examples, "only report real issues", treat diff content as data not instructions), diff rendered with explicit new-side line numbers, forced `report_findings` tool with zod-validated input; one repair retry on invalid input; JSON-in-text fallback for models without tools. *AC:* on the P2-8 fixtures ≥95% of responses validate on first or repair attempt (live). *Deps:* P2-3
- **P2-5 · FindingValidator & re-anchoring** — locate `quote` in the new-side content (exact → whitespace-normalized → fuzzy within the hunk; on multiple matches pick the one nearest the reported line); fix line numbers; drop findings outside changed lines (if `onlyChangedLines`), below thresholds or in disabled categories; dedupe (same file + overlapping range + same category → keep higher severity/confidence). *AC:* unit tests with wrong line numbers, duplicate quotes, multi-line quotes, CRLF re-anchor correctly; unanchorable findings dropped and counted in `dropped`. *Deps:* P2-4
- **P2-6 · Orchestrator** — runs chunks with a concurrency limit (default 2 Copilot / 4 Anthropic, configurable), progress events, `AbortSignal` cancellation, aggregates findings + usage into `ReviewResult`. *AC:* cancel stops in-flight requests within ~1s; partial results kept (unit, mock provider). *Deps:* P2-5
- **P2-7 · Diagnostics output + commands** — findings → Problems panel (critical/major → Error/Warning, minor → Information, nit → Hint); commands "AI Review: Review staged / unstaged / branch / current file / selection" with `withProgress` + cancel. *AC:* ext test on a fixture repo shows diagnostics on the expected lines; manual run on a real repo. *Deps:* P2-6, P1-4a
- **P2-8 · Minimal eval set** — `evals/` with 5–10 fixtures (seeded bugs + one clean diff), expected findings, runner `pnpm eval --provider anthropic` using `node-host`. Prints parse rate, findings per fixture, hits/misses. *AC:* runner works with the mock provider in CI and with Anthropic live. *Deps:* P2-6, P2-10
- **P2-9 · Security hardening** — prompt-injection notes in the system prompt, Workspace Trust check, secret ignores verified, high-entropy string redaction in diffs (optional, off by default), README data-flow section. *AC:* unit test: an `.env` file and a diff line with an AWS-style key never reach the provider. *Deps:* P2-2, P2-4
- **P2-10 · Node host** — `packages/node-host`: `GitCliDiffSource` (same modes except selection), `FsWorkspaceTools` (grep fallback for references), path sandbox (resolve symlinks, reject `..` escapes). *AC:* same parser fixtures as P2-1 pass through git CLI on a temp repo; sandbox tests. *Deps:* P2-1

**MVP milestone (exit criteria):** usable locally with Copilot; on the P2-8 evals precision ≥ 0.7 and no findings on the clean fixture; ≤ 3 nits per 100 changed lines. Then dogfood with teammates.

### Phase 3 — Real review UX
- **P3-1 · Comments API threads** — CodeRabbit-style inline threads per finding, severity badge, markdown body. Actions: Dismiss, Mark resolved. *AC:* threads appear on correct ranges; actions update state (ext test). *Deps:* P2-7
- **P3-2 · Apply fix CodeAction** — when `suggestion` exists, quick-fix replaces the re-anchored `quote` range, preserving EOL; preview via diff editor before applying. If the quote moved/changed since the review, re-anchor first; if not found, disable the fix. *AC:* applying a fix produces the expected file content (LF and CRLF fixtures); undo works; stale finding has no fix. *Deps:* P3-1
- **P3-3 · Summary view** — tree view: summary text (from P3-6), counts by severity, findings grouped by file, click-to-navigate, tokens/cost used, dropped counts. *AC:* clicking an item reveals the range. *Deps:* P2-6, P3-6
- **P3-4 · Cost estimate & confirmation (Anthropic)** — estimate input tokens before run from chunk sizes; output shown as a range; price from the model table; confirm if above a configurable threshold (default $0.50). Copilot: show request count instead. *AC:* input-token estimate within ±30% of actual on eval fixtures. *Deps:* P2-3, P2-8
- **P3-5 · Stale-finding tracking** — on `onDidChangeTextDocument` shift ranges of findings below the edit; on save re-anchor by quote; mark `stale` when not found (dimmed, no fix). *AC:* ext test: inserting lines above a finding keeps it on the right code; deleting the quoted code marks it stale. *Deps:* P3-1
- **P3-6 · Summarizer** — one extra call after chunks complete: walkthrough of the change per file + top risks, based on diff stats and findings. Skippable via setting. *AC:* summary produced for each eval fixture; included in `ReviewResult.summary`. *Deps:* P2-6

### Phase 4 — Context & agent loop
- **P4-1 · ContextBuilder** — enclosing function/class of each hunk (`vscode.executeDocumentSymbolProvider`), signatures of touched symbols (`executeDefinitionProvider`), a "changed symbols across this diff" index added to every chunk (helps cross-file issues). Node fallback: N surrounding lines. *AC:* prompt for a changed method includes the full method + class header. *Deps:* P2-3
- **P4-2 · AgentLoop** — bounded loop: max turns, max tool calls, token budget, all tools read-only. Trace logged at `debug`. *AC:* mock-provider tests cover tool round trips, limit stops, and malformed tool args. *Deps:* P1-1
- **P4-3 · WorkspaceTools (VS Code)** — readFile, grep (`workspace.findFiles` + text search), findReferences/getSymbol via LSP commands; path sandboxing to the repo root (symlinks + `..`). *AC:* tools refuse paths outside workspace; results truncated to a size cap. *Deps:* P4-2
- **P4-4 · Repo rules** — load rules markdown (`.codereview.md`, `AGENTS.md`, `.github/copilot-instructions.md`), wrap as untrusted guidance in the system prompt with a cache hint. *AC:* a rule like "never use `any`" produces findings on a fixture (live eval). *Deps:* P2-0, P2-4
- **P4-5 · Prompt caching & cost tuning** — cache breakpoints for system + rules + shared context across chunks (Anthropic). Note: caching only applies above a model-specific minimum prompt length — pad shared context or accept no caching for small prompts. *AC:* when shared prefix exceeds the minimum, the second chunk in a run shows cache-read tokens. *Deps:* P1-2, P4-4
- **P4-6 · Agentic reviewer mode** — Reviewer uses AgentLoop + WorkspaceTools when `review.mode: agentic`; per-chunk budget; ends with `report_findings`. *AC:* on evals, agentic finds ≥ 1 cross-file bug that single-pass misses, with comparison report (precision, recall, cost). *Deps:* P4-2, P4-3, P5-1

### Phase 5 — Quality & state
- **P5-1 · Eval harness (full)** — grow `evals/` to 20–30 fixtures (seeded bugs, cross-file bugs, clean diffs, CRLF), scorer (precision/recall by file + line overlap + category), JSON report, compare two runs. Evals run on Anthropic only (Copilot is not available outside VS Code). *AC:* report printed + JSON saved; manually-triggered CI workflow. *Deps:* P2-8
- **P5-2 · Verify pass** — optional second cheap call per finding ("is this a real issue given the code? yes/no + reason"); drop rejects. *AC:* measurable precision gain on evals without >10% recall loss, else stays off by default. *Deps:* P5-1
- **P5-3 · Persisted state** — per-workspace store (`workspaceState`) keyed by finding id with fuzzy fallback: dismissed/resolved; dismissed findings never resurface. *AC:* survives reload; re-review with a reworded title doesn't re-show dismissed ones. *Deps:* P3-1
- **P5-4 · Incremental re-review** — hash hunks; only send changed hunks since last review; carry over still-valid findings after re-anchoring. *AC:* re-review after a one-line edit sends one chunk. *Deps:* P5-3

### Phase 6 — CI / PR bot (later)
- **P6-1 · CLI** — `npx ai-review --base main` using core + node-host + Anthropic; outputs markdown, JSON, SARIF; exit code by severity threshold. *AC:* SARIF validates against the schema; exit code non-zero when a finding ≥ threshold exists. *Deps:* Phase 5
- **P6-2 · GitHub Action** — runs on `pull_request` (not `pull_request_target`; fork PRs without secrets skip with a notice), posts one summary comment + inline review comments only on lines inside the PR diff, updates its previous comments on re-run instead of duplicating, size limit for large PRs, respects `.codereview.yml`, key from repo secret. *AC:* on a test repo, two pushes to one PR leave exactly one summary comment and no duplicate inline comments. *Deps:* P6-1
- **P6-3 · PR source in the extension** — review a GitHub PR by number from inside VS Code (GitHub auth via `vscode.authentication`). *AC:* PR diff reviewed and findings shown on checked-out files. *Deps:* P6-1
- **P6-4 · Extra providers (optional)** — OpenAI-compatible endpoint for companies with their own gateway. *AC:* passes the provider contract tests used for P1-2. *Deps:* P1-1

### Phase 7 — Release
- **P7-1 · Packaging** — `vsce` + `ovsx` publish workflows (tag-triggered), icon, marketplace README with GIFs, CHANGELOG from changesets. *AC:* tagged release publishes to both marketplaces; installed VSIX passes a smoke test. *Deps:* MVP
- **P7-2 · Docs for teams** — setup per provider, cost guidance, privacy statement with links to each provider's data-retention terms, sample `.codereview.yml`, Copilot org-policy note (admins may restrict model access for extensions). *AC:* a teammate sets up from the docs alone without help. *Deps:* P7-1

## Risks & mitigations
| Risk | Mitigation |
|---|---|
| Noisy / false-positive findings kill adoption | Severity rubric, confidence threshold, verify pass, eval-driven prompt changes, MVP quality bar |
| Wrong line numbers | Quote-based re-anchoring (P2-5) |
| Findings drift after edits | Range shifting + stale marking (P3-5) |
| Copilot rate limits / quota | Concurrency limit, backoff, show request count, smaller chunks |
| Anthropic costs surprise users | Pre-run estimate, confirmation threshold, prompt caching |
| `vscode.lm` API changes | Isolate in `VsCodeLmProvider`; pin `engines.vscode` |
| Company code privacy concerns | No backend, no telemetry, explicit provider choice, documented data flow |
| Secrets sent to provider | Default secret ignores, optional redaction (P2-9) |
| Prompt injection via diff / rules files | Treated as data, read-only sandboxed tools, Workspace Trust required |
| Windows paths / CRLF break matching or fixes | Normalization conventions + CRLF fixtures |
| Live LLM tests flaky / unavailable on fork PRs | Deterministic unit+ext tests gate PRs; live tests on demand |

## Suggested order to start
P0-1 → P0-2 → P0-3 → P1-1 → P1-3 (Copilot first: zero setup for teammates) → P1-4a → P2-0 → P2-1 → P2-10 → P2-2 → P2-3 → P2-4 → P2-5 → P2-6 → P2-7 → P1-2 → P2-8 → P2-9 → **MVP check + dogfood** → P1-4b → Phase 3 → Phase 4/5.

> P1-2 (Anthropic) moves before P2-8 because live evals need it; it isn't needed for the Copilot MVP itself.
