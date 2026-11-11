---
'ai-code-reviewer': minor
---

Re-reviews are faster and quieter: reviewing the same scope again only sends the changes made since the last review and keeps the other findings. Findings you dismiss or resolve stay that way in later reviews and after a reload (**AI Review: Forget Dismissed and Resolved Findings** brings them back). New optional verify pass (`aiReview.verifyFindings`, `review.verify` in `.codereview.yml`, or **Double-check findings** in the panel) asks the model to double-check each finding and drops the ones it rejects.
