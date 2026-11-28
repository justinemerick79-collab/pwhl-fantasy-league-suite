# Team rules

Every agent follows these rules. When a rule here and an agent file disagree, this file wins.

## 1. The CEO

- The CEO is the owner of the business. The CEO makes all decisions.
- Agents **propose**. The CEO **approves**.
- Write for the CEO with `WRITING_STANDARD.md`: summary first, decision table, sources.

## 2. Limits

Agents **must not**:

1. Deploy to production (`firebase deploy` of any kind), or merge to `main`.
2. Change `firestore.rules` or `storage.rules` to make a test pass.
3. Run a `test-*.js` script unless both `FIRESTORE_EMULATOR_HOST` and `FIREBASE_AUTH_EMULATOR_HOST` are set.
   WARNING: 5 older scripts have no guard and write to **production** if the variables are missing.
4. Spend money, start a paid service, accept terms, or make an account.
5. Send a message to a person outside this team (email, chat, social media, GitHub mentions of real people).
6. Delete a document or data. Move Drive documents to `99 Archive`.
7. Commit or push unless the CEO asked for that change.

Agents **must**:

1. Give a source for each claim: a file and line, a URL, a data query, or a GitHub issue.
2. Say "I do not know" when they do not know. Do not guess.
3. Mark each estimate with the word "Estimate:".
4. Read `CLAUDE.md` before work on the code.

## 3. Systems of record

| Item | Where |
|---|---|
| Strategy, specs, reports, briefs | Google Drive (see `DRIVE_MAP.md`) |
| Work items | GitHub Issues in `justinemerick79-collab/pwhl-fantasy-league-suite` |
| Priority and status | GitHub Project board |
| Usage data | Firebase Analytics → BigQuery (not set up yet) |
| Decisions | Drive: `00 CEO Briefings / Decision Log` |

Name new Drive documents `YYYY-MM-DD — Type — Subject`. Upload Markdown with
`contentMimeType: text/markdown`; Drive converts it to a formatted Google Doc.

## 4. Launch gates

| Gate | Target date | What must be true |
|---|---|---|
| **G1 — Private beta** | 2027-01-08 → about 2027-04-18 | 1 to 5 invited leagues play a full season with no data loss |
| **G2 — Public web beta** | 2027-09 | Any person can sign up, make a league and invite friends. Security closed. Analytics, crash reports, backups operate |
| **G3 — Public launch + app stores** | Before the 2027-28 PWHL season (estimate: 2027-11) | iOS and Android approved. Ads operate. Load test passes |
| **Later** | After launch | Not necessary for launch |

A work item that blocks the next gate is a **launch blocker**. Launch blockers go first.

## 5. Evidence levels

| Level | Evidence | Confidence |
|---|---|---|
| **E1** | Idea or assumption only | 30% |
| **E2** | Most major competitors have it, or published market data supports it | 60% |
| **E3** | Beta managers ask for it, or a test or the code shows a defect | 80% |
| **E4** | Usage data or a measured test shows it | 100% |

An E1 item cannot get the top priority unless it is a launch blocker.

## 6. Priority score (RICE)

Score = (Reach × Impact × Confidence) ÷ Effort

| Factor | Scale |
|---|---|
| Reach | % of managers that the item affects each week (0–100) |
| Impact | 3 large · 2 medium · 1 small · 0.5 minimal |
| Confidence | From the evidence level |
| Effort | Person-weeks with Claude Code |

Sort by gate first, then by score.

## 7. Project words

| Word | Meaning |
|---|---|
| Manager | A person who owns a fantasy team |
| Player | A PWHL athlete |
| Commissioner | The manager who controls a fantasy league |
| League | A fantasy league in this app |
| PWHL | The real professional league |
| Beta | The private test in the 2026-27 season |
| Launch | The public release for the 2027-28 season |
