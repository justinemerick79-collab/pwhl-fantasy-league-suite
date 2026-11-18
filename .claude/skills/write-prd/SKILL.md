---
name: write-prd
description: Write a PWHL Fantasy product requirements document (PRD) for one feature and put it in Google Drive (02 Product Specs), then open the matching GitHub issues. Use when a feature is approved for work and needs a spec.
---

# Write a PRD

Read `.claude/team/TEAM_RULES.md` and `.claude/team/WRITING_STANDARD.md` first.

## Steps

1. Read the feature's GitHub issue and any earlier documents in Drive about it.
2. Read the code that the feature touches. Name the files and functions.
3. Check the competitor benchmark (Drive: Competitive Landscape & Market) for how others do it.
4. Write the PRD:

```markdown
# PRD — <feature>

**Author:** Product Manager agent · **Date:** <date> · **Gate:** <G1|G2|G3> · **Evidence:** <E1–E4> · **Issue:** #<n>

## Summary
<What, for whom, why now. 5 lines or fewer.>

## DECISION NEEDED (only if there is one)

## Problem
<What managers cannot do today. Evidence with sources.>

## Goals and non-goals

## User stories
- As a <manager | commissioner>, I want <X> so that <Y>.

## Requirements
| # | Requirement | Priority (Must / Should / Could) |

## Acceptance criteria
- Given <state>, when <action>, then <result>.

## Design notes
<Flows, screens. Link the ux-designer output.>

## Technical notes
<Files, functions, Firestore documents, security rules, Cloud Functions. Scale and cost effect.>

## Success metric
<Which number, current value, target, how to measure.>

## Risks and open questions

## Sources
```

5. Upload to `02 Product Specs` as `text/markdown`. Title: `YYYY-MM-DD — PRD — <feature>`.
6. Open one GitHub issue for each buildable part with the feature template. Link the PRD in each issue.

## Rules

- Every acceptance criterion is testable by the QA lead.
- Use `getSimulatedDate()` for dates and `getPSTDateStr()` for game-day keys. Positions are F / D / G.
- Name the scale and security effect, or write "None".
