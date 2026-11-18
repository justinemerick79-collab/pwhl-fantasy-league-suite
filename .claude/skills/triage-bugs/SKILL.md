---
name: triage-bugs
description: Triage new PWHL Fantasy bugs — reproduce, find the cause in the code, set severity and labels, and propose a fix. Use when a bug is reported (by the CEO, a beta manager, or an issue), or daily during the beta.
---

# Triage bugs

Read `.claude/team/TEAM_RULES.md` first.

## Steps

1. Find new bugs: `gh issue list --label bug --search "no:assignee"` and any reports from the CEO.
2. For each bug:
   1. **Reproduce.** Use the emulator, or `npm run dev` with the preview tools. WARNING: Set both emulator variables before you run any `test-*.js` script.
   2. **Find the cause.** Give the file and line.
   3. **Set the severity** (S1 wrong score / data loss / draft stops / security; S2 main feature fails with no workaround; S3 workaround exists; S4 cosmetic).
   4. **Set the gate.** S1 is always a launch blocker for the current gate.
   5. **Propose a fix** in one paragraph, and the test that proves it.
3. Write the triage result as a comment on the issue. Ask the CEO before you apply labels to more than a few issues.
4. If you find an S1, tell the CEO in chat at once.

## Also check

- `node check-pwhl-feed.js` — the upstream feed. A rename upstream shows as missing points, not as an error.
- Cloud Functions logs: `firebase functions:log --only <name>` (read-only).
