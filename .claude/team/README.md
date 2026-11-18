# The AI team

This folder holds the rules that every agent in `.claude/agents/` follows. The full design, with the
reasons for each choice, is the **Agent Operating Model** in Google Drive (folder `09 Agent Operations`).

| File | Contents |
|---|---|
| `TEAM_RULES.md` | Limits, evidence levels, priority method, launch gates. **Every agent reads this first.** |
| `WRITING_STANDARD.md` | How to write for the CEO (ASD-STE100 rules) |
| `DRIVE_MAP.md` | Google Drive folder and document IDs |

## How to use the team

- Talk to the Chief of Staff: "Ask the chief-of-staff agent for this week's brief."
- Ask a specialist directly: "Use the infra-architect agent to review the cost of `snapshotDailyGameStats`."
- Run a procedure: `/ceo-brief`, `/write-prd`, `/score-backlog`, `/triage-bugs`, `/scale-review`.

| Agent | Role |
|---|---|
| `chief-of-staff` | CEO contact; weekly brief; Decision Log; sends work to the others |
| `head-of-product` | Roadmap, launch gates, backlog priority |
| `product-manager` | PRDs and GitHub issues with acceptance criteria |
| `research-analyst` | Competitor, market, analytics and beta-feedback evidence |
| `ux-designer` | Flows, screens, design system, usability |
| `tech-lead` | Architecture, code quality, PR review, `CLAUDE.md` |
| `infra-architect` | Firebase scale, cost, security rules, monitoring |
| `qa-lead` | Test plans, bug triage, release checks |
| `mobile-lead` | iOS and Android apps, store submission |
| `fantasy-intelligence` | AI advice: start/sit, waivers, trades, projections |
| `growth-monetization` | Ads, revenue, growth, legal and store compliance |
