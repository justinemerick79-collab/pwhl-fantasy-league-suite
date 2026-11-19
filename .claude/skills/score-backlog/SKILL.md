---
name: score-backlog
description: Score and rank the PWHL Fantasy GitHub backlog with launch gates, evidence levels and RICE, then publish the ranked table. Use when the CEO or head of product asks to re-prioritize, after new evidence arrives, or monthly.
---

# Score the backlog

Read `.claude/team/TEAM_RULES.md` (sections 4–6) first.

## Steps

1. List the open issues: `gh issue list --state open --limit 200 --json number,title,labels,body`.
2. For each issue, find or set:
   - **Gate** label: `gate:G1`, `gate:G2`, `gate:G3` or `gate:later`.
   - **Evidence** label: `evidence:E1` to `evidence:E4`. Give the source in a comment if you change it.
   - **Reach** (% of managers each week), **Impact** (3, 2, 1, 0.5), **Effort** (person-weeks).
3. Compute the RICE score = Reach × Impact × Confidence ÷ Effort. Confidence comes from the evidence level (E1 30%, E2 60%, E3 80%, E4 100%).
4. Sort by gate, then by score. Launch blockers go to the top of their gate.
5. Check the plan fits. Add the effort of each gate. Compare it with the weeks that remain before the gate date. If it does not fit, list what to delay.
6. Show the CEO the table: rank, issue, title, gate, evidence, RICE, effort. Then "What changed, and why".
7. **Ask the CEO before you change labels or the Project board.** Then apply the labels with `gh issue edit <n> --add-label ...`.

## Rules

- An E1 item cannot rank first in its gate unless it is a launch blocker.
- Defects that change a score or lose data are always launch blockers.
