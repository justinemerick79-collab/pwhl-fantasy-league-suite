---
name: scale-review
description: Run the PWHL Fantasy monthly scale, cost and security review of Firebase — Firestore read/write patterns, document size limits, Cloud Functions timeouts, security rules and a cost model by user count. Use monthly, before a gate, or before a change to data access, functions or rules ships.
---

# Scale review

Read `.claude/team/TEAM_RULES.md` and the "Known risks" table in `.claude/agents/infra-architect.md` first.

## Steps

1. **Check the known risks.** For each row, find whether the code still has the problem. Mark it Open, Fixed or Changed, with the commit.
2. **Look for new risks** in changes since the last review (`git log --since="1 month ago" -- src/services functions firestore.rules`):
   - Queries with no `where` or `limit` on large collections.
   - Reads inside loops (N+1).
   - Documents that grow with the number of leagues or managers (1 MiB limit).
   - Functions that loop over all leagues in one run (540 s limit).
   - Rules with `allow read, write: if isAuthenticated()`.
   - Callables with no `request.auth` check.
   - Compound queries with no entry in `firestore.indexes.json`.
3. **Update the cost model.** For a typical manager in a week, estimate document reads, writes and function time. Show the cost at 100, 1,000, 10,000 and 50,000 managers. Mark each number "Estimate:". Get current Firebase prices from the official pricing page; do not use memory.
4. **Write the report** in `05 Engineering & Infrastructure`. Title: `YYYY-MM-DD — Report — Scale Review`. Lead with: does the system carry the next gate's load? Yes or no.
5. Open a GitHub issue for each new risk. Ask the CEO first if there are more than 3.

## Rules

- Read-only. Do not deploy, do not change rules, do not run scripts against production.
