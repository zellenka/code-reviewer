---
'ai-code-reviewer': minor
'@ai-review/core': minor
---

Context and agentic reviews: the model now sees the enclosing function or class of each change (from the language server when available) and, for multi-file changes, the declarations changed across the diff. Repository rules from `.codereview.md` (or `rules:`), `AGENTS.md` and `.github/copilot-instructions.md` are applied as review criteria. New agentic mode (`review.mode: agentic` or the `aiReview.reviewMode` setting): the model can read files, search code and find references (read-only, secrets refused) before reporting, within per-part limits (`aiReview.agent.*`). Anthropic reviews with several parts now reuse the cached prompt prefix. New settings: `aiReview.reviewMode`, `aiReview.includeContext`, `aiReview.agent.maxTurns`, `aiReview.agent.maxToolCalls`, `aiReview.agent.tokenBudget`.
