# Contributing

Thanks for helping out! This is a pnpm monorepo for a VS Code extension (and, later, a CLI/GitHub Action) that share one review engine.

## Setup

Requirements: Node.js 22 (see `.nvmrc`), pnpm (version pinned in `package.json` → `packageManager`), VS Code 1.95 or newer.

```sh
corepack enable pnpm   # once; on Windows without admin: corepack enable --install-directory "%APPDATA%\npm" pnpm
pnpm install
pnpm build
```

## Layout

| Path                 | What                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `packages/core`      | Pure TypeScript review engine. **Must not import `vscode`** (enforced by ESLint) so it can run in the CLI, evals and CI. |
| `packages/vscode`    | The extension: commands, UI, VS Code-specific providers. Bundled with esbuild into `dist/extension.js`.                  |
| `packages/node-host` | Node implementations (git CLI diffs, file-system tools) used by evals and the future CLI.                                |
| `evals/`             | Review-quality evals: fixture diffs with expected findings, a runner and a report comparer.                              |

A `cli` package follows in a later phase — see [implementation-plan.md](implementation-plan.md).

## Evals

Fixtures live in `evals/fixtures/*.yml` (`before`/`after` files, `expected` findings; `eol: crlf` for CRLF files; `category` may list several accepted categories). A finding counts as a hit when file, lines (±2) and category match.

```sh
pnpm eval                                   # mock oracle: checks the pipeline, must be 100% (runs in CI)
pnpm eval --provider anthropic --json a.json   # real model; needs ANTHROPIC_API_KEY
pnpm eval --provider anthropic --verify --baseline a.json   # with the verify pass, compared with a.json
pnpm eval:compare a.json b.json             # compare any two reports
```

`--mode compare` runs single-pass and agentic. The manual **Live tests** workflow runs the same against Anthropic and uploads the JSON reports.

## Everyday commands

| Command                     | What                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `pnpm build`                | Type-check and build all packages, bundle the extension                                               |
| `pnpm test`                 | Unit tests (Vitest). Deterministic, no network                                                        |
| `pnpm test:ext`             | Extension tests in a downloaded VS Code. Set `VSCODE_TEST_VERSION=1.95.0` to test the minimum version |
| `pnpm test:live`            | Tests against real providers. Needs `ANTHROPIC_API_KEY`, costs money, not run on PRs                  |
| `pnpm lint` / `pnpm format` | ESLint / Prettier                                                                                     |
| `pnpm changeset`            | Describe a user-facing change for the changelog                                                       |

## Running the extension

Open the repo in VS Code and press **F5** ("Run Extension"). In the new window run **AI Review: Hello** from the Command Palette. Logs are in the Output panel → "AI Review" (or run **AI Review: Show Log**).

## Tests

- **Unit** (`*.test.ts` next to the code in `packages/*/src`) — use the mock provider, never the network.
- **Extension** (`packages/vscode/test`) — run inside VS Code via `@vscode/test-cli`. To run or debug them from the editor, install the recommended **Extension Test Runner** extension and use the Testing sidebar (run `pnpm build` first; it runs the compiled tests in `out/`).
- **Live** (`*.live.test.ts`) — real providers; started by hand in CI ("Live tests" workflow).

## Conventions

See _Conventions_ in [implementation-plan.md](implementation-plan.md): 1-based inclusive lines in core, repo-relative POSIX paths, `\n`-normalized text, no API keys ever in logs and no code content below `trace`.

## Pull requests

- Keep PRs focused; add tests for behavior changes.
- Add a changeset for anything user-facing.
- Never commit API keys, and don't paste private code into issues.

By contributing you agree your contributions are licensed under the [Apache License 2.0](LICENSE).
