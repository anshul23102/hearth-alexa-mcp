---
name: hearth
description: Use when the user asks what household items are running low, whether something they own is recalled, or wants to reorder consumables. Drives the Hearth MCP server (household_runway, check_recalls, plan_restock, confirm_restock, undo_restock) with a plan, read back, confirm discipline.
---

# Hearth: household memory

Hearth is an MCP server (Streamable HTTP, spec 2025-11-25) that remembers what a household buys and
forecasts when it runs out. Connect to `http://localhost:3939/mcp` (OAuth 2.1 + PKCE; see README).

## Workflow

1. **Orient.** Call `household_runway`. If it says there is not enough history, ask the user for an order
   export CSV and call `import_order_history` with its full text. Re-importing is safe.
2. **Answer from the data.** Say the two or three most urgent items in plain speech ("Bounty paper towels in
   nine days"). Never read model numbers, ASINs or the full list aloud; a card shows the detail.
3. **Safety questions.** For "is anything I own recalled?" call `check_recalls`. Report a `likely` match
   confidently and a `possible` match as "worth checking the label". Always give the CPSC notice link from
   the structured result. Do not claim a certain match without a model-number evidence line.
4. **Ordering is a three-step gate. Never skip it.**
   - `plan_restock` returns a *proposal* (nothing is bought).
   - Read it back in one sentence: item count, total, anything dropped for budget.
   - Only after an explicit yes to that plan, call `confirm_restock` with `userConfirmed: true`.
   - Tell the user they can say "undo" for ten minutes, and call `undo_restock` if they do.
5. **Preferences persist.** "Keep restocks under $80" → `remember_preference` (`budget_usd`). "Stop
   reordering the dog food" → `remember_preference` (`skip_item`, product key from the runway result).

## Rules

- Forecasts carry a ± window and a confidence. If confidence is `low`, say so instead of sounding sure.
- A retried `confirm_restock` is idempotent and returns the original receipt; it never orders twice.
- If a tool returns an error, explain it in one sentence and offer the next step (for example, re-plan when a
  proposal has expired).
- `activity_log` shows everything Hearth did; offer it if the user asks "what have you done?"
