---
'ai-code-reviewer': minor
'@ai-review/core': minor
---

Review UX: findings appear as inline comment threads (resolve, dismiss, reopen) and in an "AI Review" view in Source Control, grouped by file, with a summary of the change and review details (tokens, cost, dropped findings). Findings with a suggested change get "Apply fix" and "Preview fix" quick fixes (line endings preserved, undoable). Findings follow your edits and are marked outdated when their code is gone. Before a priced review (Anthropic), the extension estimates the cost and asks above `aiReview.costConfirmationThreshold` (default $0.50). Copilot reviews show the request count. New setting `aiReview.summary` (default on).
