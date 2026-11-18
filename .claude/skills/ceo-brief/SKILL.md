---
name: ceo-brief
description: Make the weekly PWHL Fantasy CEO brief — a one-page status, decisions-needed and next-steps document in Google Drive (00 CEO Briefings). Use when the CEO asks for a brief, a status update, "where are we", or on the Monday schedule.
---

# CEO brief

Read `.claude/team/TEAM_RULES.md`, `.claude/team/WRITING_STANDARD.md` and `.claude/team/DRIVE_MAP.md` first.

## Steps

1. Find the brief number. Search Drive folder `00 CEO Briefings` for titles that contain "CEO Brief". Use the next number.
2. Collect the facts for the last 7 days:
   - `git log --since="7 days ago" --oneline --all`
   - `gh pr list --state all --search "updated:>=$(date -v-7d +%Y-%m-%d)"`
   - `gh issue list --state all --search "updated:>=$(date -v-7d +%Y-%m-%d)"`
   - Open launch blockers: `gh issue list --label launch-blocker`
   - Drive documents changed in the last 7 days (`search_files`, `modifiedTime >`).
3. Read the latest Launch Roadmap. Find the next gate and the days that remain.
4. Find the decisions that the CEO must make. Each one needs options and a recommendation.
5. Write the brief in this shape:

```markdown
# CEO Brief #<n> — <date>

**From:** Chief of Staff agent · **Overall status: <GREEN|AMBER|RED>**

## Summary
<5 lines or fewer>

## DECISIONS NEEDED
| # | Decision | Recommended | Why | Document |

## Status by area
| Area | Status | One line |
(Core game, Security, Scale, Data and analytics, Mobile, Revenue, Legal, Market)

## Done this week
## Next week
## Risks
| Risk | Effect | Action |
## Key dates
```

6. Upload it to `00 CEO Briefings` as `text/markdown`. Title: `YYYY-MM-DD — CEO Brief #<n>`.
7. Give the CEO the link and the decisions in chat.

## Rules

- 1 page. No technical words in the Summary.
- Every status has a reason. Every decision has a recommendation.
- Do not repeat old news. Say what **changed**.
