# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

PWHL fantasy hockey league suite — a React + Vite SPA on Firebase (Firestore, Auth, Cloud Functions, Hosting).
Firebase project: `pwhl-fantasy-mobile-26`. Live at https://pwhl-fantasy-mobile-26.web.app.

Note `package.json` is still named `temp_web` and `README.md` is the stock Vite template; neither reflects the project.

## AI team

The business runs with a team of Claude Code agents (`.claude/agents/`) and procedures (`.claude/skills/`:
`/ceo-brief`, `/write-prd`, `/score-backlog`, `/triage-bugs`, `/scale-review`). Their shared limits, launch
gates, evidence levels and priority method are in `.claude/team/TEAM_RULES.md`; read it before acting as one
of them. Business documents live in Google Drive (`.claude/team/DRIVE_MAP.md`); work items live in GitHub
Issues. Write for the CEO with `.claude/team/WRITING_STANDARD.md` (ASD-STE100 based).

## Commands

```bash
npm run dev        # Vite dev server — REQUIRED for any live PWHL API work (see API proxy below)
npm run build      # Vite build to dist/
npm run lint       # eslint (8 findings, all accepted — see Linting below)

node check-pwhl-feed.js   # upstream PWHL feed health check — read-only, no emulator needed
```

Deploys (Firebase CLI is authenticated; `pwhl-fantasy-mobile-26` is the active project, set via local
CLI state because `.firebaserc` has an empty `projects` map):

```bash
npm run build && firebase deploy --only hosting   # hosting serves dist/, so ALWAYS build first
firebase deploy --only functions
firebase deploy --only firestore:rules
```

### Integration tests

There is no test runner and no `npm test`. The root `test-*.js` and `verify-test-league.js` files are
standalone end-to-end scripts that drive the **Firebase emulator**. Run one at a time:

```bash
firebase emulators:start --only functions,firestore,auth   # separate terminal
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 npx tsx test-bot-draft.js
```

**The Firestore and Auth emulators need a Java runtime.** macOS ships only a `/usr/bin/java` stub, so
without a real JDK every one of these tests fails at startup with "Unable to locate a Java Runtime". There
is no Homebrew or usable `sudo` on this machine, so Temurin 21 is installed user-locally at
`~/.local/java/jdk-21.0.13+9` with `java` symlinked into `~/.npm-global/bin` (already on PATH). The
Functions emulator alone does not need Java, and is still useful on its own: it reports which trigger type
each function registers as.

**Pass the emulator host env vars explicitly.** The scripts seed fixtures with the Admin SDK, which talks to
**production** when `FIRESTORE_EMULATOR_HOST` is unset. `test-bot-draft.js` refuses to run without it;
the other scripts do not yet have that guard.

#### Fixture setup goes through the Admin SDK, not the client SDK

`firestore.rules` is strict on purpose: a user may only create their *own* `users/{uid}` document and only
with `role: 'user'`, and only an existing admin may update one. Test fixtures need the opposite — writing
another user's document (the bot) and granting `role: 'admin'` — so client-SDK seeding gets
`PERMISSION_DENIED` at the first write.

**Do not relax `firestore.rules` to make a test pass.** Permitting that seeding would let any user
self-promote to admin and write other users' documents. Seed with the Admin SDK instead, which bypasses
rules by design; rules are exercised by the app, not by fixture setup. `test-bot-draft.js` shows the shape:
client SDK for authentication (to obtain a real uid), Admin SDK for all Firestore setup, assertions and
teardown, behind a small shim so the call sites still read like the modular client API.

All five scripts now seed this way via `test-support.js`, and all five **refuse to run** unless both
`FIRESTORE_EMULATOR_HOST` and `FIREBASE_AUTH_EMULATOR_HOST` are set. That guard matters:
`test-daily-lineups.js` previously connected no emulator at all, so running it created a real Auth user and
wrote and deleted documents in **production**. It now also wires `src/firebase.js`'s client instances to the
emulator, since `leagueService` writes through those and the web SDK ignores the env var.

Current state when run against the emulator with the repo's own rules:

| Script | Result |
|---|---|
| `test-time-machine.js` | **passes** |
| `verify-test-league.js` | **passes** (all 4 assertions) |
| `test-daily-lineups.js` | **passes** |
| `test-matchup-resolution.js` | **passes** |
| `test-bot-draft.js` | **passes** |
| `test-draft-roster-needs.js` | **passes** |
| `test-admin-callables.js` | **passes** |
| `test-league-schedule.js` | **passes** |
| `test-season-weeks.js` | **passes** (reads the live feed; writes only to the emulator, then removes what it wrote) |
| `test-server-transactions.js` | **passes** |
| `test-playoffs.js` | **passes** |
| `test-live-scoring.js` | **passes** (replays `test-fixtures/gamesummary-358-final.json` through a stubbed fetch) |
| `test-data-sync.js` | **passes** (calls `runDataSync` as an admin for season 10; live feed in, emulator out) |
| `test-player-universe.js` | **passes** (stubbed feed) |
| `test-season-pool.js` | **passes** (one fallback rule client + server; bot drafts only the league's season; picks store real position) |
| `test-beta-rehearsal.js` | **passes** — one private league start to finish through the real code (see below) |
| `test-draft-rankings.js` | **passes** |

All seventeen pass. Tests that run the real sync must wait for the background `onGameSummaryWritten` writes to
stop before cleanup (see `test-season-weeks.js`), or leftover players leak into later tests (`test-bot-draft.js`). `test-admin-callables.js` also needs the Functions emulator on port 5001, so start all three
emulators — or run any of these via `firebase emulators:exec --only functions,firestore,auth "npx tsx <script>"`,
which starts the emulators, sets both env vars, runs the script and shuts down.

Admin-only callables check the caller with `requireAdmin(request, action)` at the top of `functions/index.js`.
Call it first, **outside** any `try` whose `catch` rewraps errors (as `generateSeasonProjections`' does), or the
caller sees `internal` instead of `permission-denied`. Any new admin callable belongs in that test's `ADMIN_ONLY` list.

### Week boundaries come from the season document

The game loop resolves weeks from `pwhl_seasons/{season_id}.weeks` (`getWeekBounds` in `functions/index.js`).
When that array is missing, the league is **skipped with an error** naming the season:

```
[Game Loop] League <id> skipped: season <n> has no `weeks` array (pwhl_seasons/<n>).
Run the season sync so generateWeeksList() populates it.
```

It used to fall back to a hardcoded epoch (`baseTime = 2024-01-01`) and derive fixed 7-day blocks, so a
season without its week map produced confidently wrong dates — matchups settling on the wrong days, or never
— with nothing logged. `getWeekBounds` now returns `null` rather than inventing boundaries, and each call
site skips instead of guessing. Week boundaries are data; do not reintroduce a default.

That silent fallback is what broke `test-matchup-resolution.js`: it never seeded the season, so Week 1
resolved to 2024-01-01 → 2024-01-08, placing its 2024-01-02 warp *inside* Week 1 instead of past it.
**Any fixture that exercises the game loop must seed `pwhl_seasons/{id}.weeks`.**

**The daily server sync builds the week map.** `syncDailyData` writes each recent season's feed row and its
`weeks` to `pwhl_seasons/{id}` using `functions/seasonWeeks.js#buildSeasonWeeks`. Before this, only the
dev-server admin sync wrote it. Weeks run Monday 00:00 → Sunday 23:59:59.999 **Pacific**; week 1 contains the
season's `start_date`; games are placed by their `date_played` **string**, never `new Date('YYYY-MM-DD')` (that
is midnight UTC, 4 pm Sunday Pacific, and used to move every Monday game into the previous week). An empty
schedule never replaces an existing week map. The client's `generateWeeksList()` in `pwhlService.js` is a copy of
the same rules for the admin sync — **keep the two in step**; `test-season-weeks.js` fails if they differ.

The simulation schedules the first 14 *game* weeks of its season (skipping off weeks), so with real season data
its weeks are not 1–14; `verify-test-league.js` derives its expectation the same way.

### Real leagues get their schedule when the draft completes

`functions/schedule.js` builds the regular-season schedule. `onDraftWritten` calls `generateLeagueSchedule` when
`fantasy_leagues/{id}/draft/state` changes to `status: 'completed'` — both the client (human last pick) and the
server (bot last pick) make that write, so the one transition covers both. Simulation leagues are skipped; they
still build their own schedule in `initializeTestEnvironment`.

- Uses only non-off weeks that **start after** the draft, and sets `currentWeek` to the first of them. Settlement
  starts from `currentWeek`, so without this a league drafted mid-season would settle its past weeks with no games.
- Reserves the last `ceil(log2(playoffTeams)) × playoffDuration` game weeks for playoffs, recorded in
  `league.schedule.playoffWeeks` (see Playoffs below).
- Circle-method round-robin, repeated with home/away swapped on each pass. Odd team counts give one bye a week
  (no matchup document). `matchupDuration: 2` keeps the same pairs for 2 weeks, but each week still settles on its
  own — `finalizeLeagueWeek` is per week.
- Idempotent: does nothing if the league already has any matchup. Team order is sorted, so a retry is identical.
- No week map → skipped with a logged error, the same rule as `getWeekBounds`.

### Live scoring and the official switch

`functions/liveStats.js` (plan: Drive, folder 05, "Plan — Live Scoring, Nightly Official Stats, Stat Corrections").
One parser and scoring formula, `functions/boxScore.js#normalizeBoxScore` / `pointsForGame`, serve live scoring,
the official switch, settlement **and** the simulation (`calculatePlayerStatsFromSummary` is now a wrapper; a
parity run over 10 real games showed 0 differences). Server game days are **Pacific** (`functions/dates.js`).

| When (Pacific) | Job | Does |
|---|---|---|
| every 5 min | `liveGamePoller` → `runLivePoll` | Reads `live_state/current`; on a day without games it stops there. From 30 min before puck drop it fetches each game until Final, then at +15/+30/+60/+120 min (`POST_GAME_CHECK_MIN`), and rebuilds the day's points when stats **or status** change |
| 1:00 am | `reconcileFinalStatsScheduled` | Re-checks every game of the last 3 days; marks stable finals `official`; logs corrections |
| 3:00 am | `syncDailyData` | Schedule + week maps; rebuilds yesterday from box scores (old summary path if a day has none); re-plans today |
| 4:00 am | `planGameDayScheduled` | Writes `live_state/current` from `pwhl_games where date_played == today` |
| hourly | `settleMatchupWeeksScheduled` | Settles a week only when every game in `weeks[].games` is `official` (`ensureWeekOfficial` re-checks now); after 24 h it settles anyway and writes an `unconfirmed_settlement` notice |

- `game_box_scores/{gameId}` status: `live` → `final` (status 4 seen) → `official` (final, `meta.final == "1"`, and
  unchanged for 30 min **or** `last_modified` 12+ h old). A change after Final writes `stat_corrections` entries;
  a change after official reopens the game to `final` (`afterOfficial: true` on the entry).
- Goalie W/L/OTL/SO count only at status 4 (preseason games can show a practice OT/shootout before Final).
- `pwhl_game_summaries` is written only when a game becomes official — that write fires the heavy
  `onGameSummaryWritten` season-totals rebuild, which must not run every 5 minutes.
- Day status in `daily_game_stats/{date}`: `live` / `final` / `official`. The old `preliminary` value is gone.
- **In the app:** `src/hooks/useLiveStats.js` — `useLiveDay(date)` listens to `daily_game_stats/{date}`; Matchup
  (today) and Roster (the viewed day) add its `version` to their data-loading effect, so each server update reloads
  the data once; `LiveBadge` shows LIVE · updated / Final (unofficial) / Final. `useLiveGames()` feeds the "PWHL
  Games Today" panel (status, score, period, clock from `live_state/current`). `StatCorrectionsFeed` (League →
  Transactions) lists corrections for rostered players with the point change from `src/services/scoring.js`, a
  client copy of `boxScore.js` scoring that `test-live-scoring.js` checks for parity.
- **Open (Step 0):** whether LeagueStat's box score changes during play is being measured on games 363/364. If it
  does not, only the fetch layer changes (Firebase goals for live G/A/+/-).

### Playoffs

`functions/playoffs.js#afterWeekSettled` runs at the end of `finalizeLeagueWeek` — the one settlement path for
real leagues (weekly scheduler) and per-league simulations. The legacy global simulation
(`onSimulationStateWritten`) has its own settlement code and gets no playoffs.

- After the last `schedule.regularSeasonWeeks` week settles: seed the top `scheduleSettings.playoffTeams` by win %
  (tie = half a win), then points, then id — the Standings table sorts the same way. Non-power-of-two brackets
  give the top seeds a round-1 bye; every round the best remaining seed plays the worst.
- Playoff matchups are ordinary matchup docs with `isPlayoff: true`, `round`, `homeSeed`/`awaySeed`, stored under the
  round's **last** week (`roundStart` covers multi-week rounds). `finalizeLeagueWeek` scores them over the round,
  breaks a tie by seed, and **never** touches team W/L/T or points.
- State lives in `league.playoffs` (`seeds`, `alive`, `byes`, `round`, `totalRounds`, `status`, `championTeamId`).
  Every step re-reads it inside a transaction, so running it twice does nothing.
- Simulation leagues get `schedule.playoffWeeks` = the 2 game weeks after their 14 regular weeks, when the season's
  week map is long enough; otherwise the simulated season ends after week 14.
- `src/components/PlayoffBracket.jsx` displays it on the Standings tab.

### The daily_lineups date comparison

`daily_lineups/{date}` document ids are date-only (`YYYY-MM-DD`), but `current_simulated_date` may carry a
time — `getSimulatedDate()` in `TimeTravelContext` explicitly accepts both forms. The rule compared the two
as plain strings, and `"2023-12-28" >= "2023-12-28T12:00:00-08:00"` is **false**, because the shorter
date-only id sorts before the same date with a time suffix. A timestamped clock therefore blocked *every*
lineup save for the current day, silently.

The rule now compares `current_simulated_date[0:10]`. Production is unaffected either way — every writer
(`SIMULATION_START_DATE`, AdminPanel's date input, `App.jsx`'s `.split('T')[0]`) stores date-only — so this
is defence against a format the app already supports. The security property is unchanged and still tested:
`test-daily-lineups.js` STEP 3 confirms past-date edits are still rejected.

**Keep comparing dates to dates.** If another rule ever compares a document-id date against a stored
timestamp, slice it the same way.

### Auto-draft must never stall

Bot picks are chosen in `functions/index.js` (`handleDraftStateChange`) and mirrored in
`DraftRoom.jsx` (`getTopAvailablePlayer`) for the client-side auto-pick. **Keep the two in step.**

Roster limits were originally only a *veto*: candidates that would breach a position maximum, or leave a
starter minimum unreachable, were filtered out, and whatever scored highest among the survivors was taken.
Nothing ever *preferred* a needed position. Late in a draft that veto can reject every single candidate —
most easily when a position the bot still needs has been drained from the pool — and the engine then
returned without picking, freezing the draft for every team with that bot on the clock.

Selection now works in tiers, strictest first, and the last tier takes any undrafted player:

1. position maximums respected **and** all starter minimums still reachable
2. position maximums only
3. anything undrafted

Within the chosen tier, when `picksRemaining <= totalNeeded` there is no slack left, so the pick is
restricted to positions still short of their starter minimum — deliberately taking a lower-ranked player to
keep the roster completable. Falling past tier 1 logs a warning naming the counts and limits.

**A stalled draft is worse than an imperfect roster.** Do not reintroduce a path that returns without
picking while undrafted players remain.

Position counts come from matching roster ids against `pwhl_players`, where doc ids are
`<seasonId>_<playerId>` while rosters store the bare player id — so match on `player_id` first. An
unresolved player used to be silently counted as a forward, skewing the very counts the veto depended on;
it is now logged.

`test-draft-roster-needs.js` covers both halves: a bot that needs a position no longer in the pool must
still pick, and a bot with no slack must take a needed position over a far higher-scoring one.

### Bot draft ranking

Bots (`handleDraftStateChange`) and auto-picks (`DraftRoom.getTopAvailablePlayer`) rank by **draft value**:
projected fantasy points for the league's season under the **league's own scoring**
(`functions/draftRanking.js`, browser copy `src/services/scoring.js#projectedPoints` — keep in step;
`test-draft-rankings.js` checks they agree). Data, best first: `pwhl_projections/{S}/player_projections`
→ the player's previous regular season (`pwhl_player_stats`) → an inline `points` field (only the built-in dev pool
and test fixtures) → 0. Until 2026-11-28 both read a `stats` field real player docs do not have, so every player
scored 0 and bots drafted alphabetically.

- The season and draft values load **before** the draft transaction. The season safety net can write the league
  doc; doing that (or long reads) inside the transaction failed the pick with "Transaction is invalid or closed".
- **Projections must exist for the season** (Admin Console → Generate projections) or rookies rank last.
- Goalies can still lead the board under the default scoring — a deliberate decision. When scoring is rebalanced,
  `EXPECTED_TOP_PICK` in `test-bot-draft.js` is the single value to update.

### Provider nesting is load-order-sensitive

`src/main.jsx` does two things before React mounts, and both matter:

1. **Deletes local Firestore IndexedDB databases** (hardcoded names containing `pwhl-fantasy-mobile-26`) to
   avoid connection timeouts and stale emulator caching. If the project ID ever changes, update that list.
2. **Dynamically imports** the providers and `App` only after that cleanup, so nothing touches Firestore early.

The nesting order is required: `AuthProvider` → `TimeTravelProvider` → `DataProvider` → `App`.
`TimeTravelProvider` resolves the active league/season that `DataProvider` then loads data for.

Init failures are caught and rendered as a raw HTML error card into `#root` — if the app shows a red
"App Initialization Failed" panel, the stack trace is already on screen.

### Simulation / "time travel" is the core cross-cutting concern

Almost every date in the app is a *simulated* date, not `Date.now()`. `TimeTravelContext.getSimulatedDate()`
resolves in strict priority order:

1. **Per-league** simulation — `fantasy_leagues/{id}.isSimulation` + `.simulatedDate` (current architecture)
2. **Global** simulation — `admin_settings/simulation_state.testModeActive` + `.current_simulated_date` (legacy, kept for back-compat)
3. Real `new Date()`

Bare `YYYY-MM-DD` strings are deliberately parsed as `T08:00:00-08:00` to avoid UTC midnight drift.
**When adding date logic, call `getSimulatedDate()` — never `new Date()` directly.** Both legacy and
per-league paths must keep working.

**Waivers and accepted trades are processed on the server**, never in the browser (`functions/transactions.js`).
`processTransactionsScheduled` runs every 15 minutes for all `active`/`active_full` leagues, using each league's
`getSystemDate`; `onLeagueSimulatedDateWritten` also runs it when a simulation's date moves; `onTradeWritten`
processes an `accepted_immediate` trade at once. Each waiver run reads everything before writing and tracks rosters
in memory (the old client version failed when two waivers expired together and kept only one of a team's wins);
each trade is re-read inside its own transaction and processed only if still waiting. The client only *submits*
claims, drops and trade responses.

Services that need simulation state outside React re-read it from Firestore via their own local
`checkIsSimulation()` helpers (in `statsEngine.js` and `pwhlService.js`), which read
`localStorage.pwhl_active_league`. That key is the bridge between the React context and the service layer.

### League lifecycle and the beta rehearsal

`leagueService.createLeague` / `joinLeague` are the **only** create and join paths (LeagueHub calls them). A
league stores its PWHL season as `season_id` (the app's active season, `app_settings/active_season`) — every
server job keys off it. Before 2026-11-28 creation never stored it, so a real league drafted and then got no
schedule; `functions/leagueSeason.js#resolveLeagueSeasonId` is the server safety net (adopts the active season,
saves it, warns — never a hardcoded default). `waiverOrder` holds **team** ids, and each joining team is appended.
Invite codes use `crypto.getRandomValues`.

`initializeDraft` takes "who is a bot" from the league's **team** docs (`isBot`). It must not read other managers'
`users/{uid}` docs inside its transaction: the rules allow only the owner or an admin, so a non-admin commissioner
could not start the draft (simulations hid it — the admin was always commissioner).

`test-beta-rehearsal.js` runs one 4-team league through the real code: admin sync builds the universe → create →
3 joins (+ a refused 5th) → 60-pick snake draft as signed-in users against the rules → schedule trigger → lineup →
live game day → official switch → add/drop + waiver claim → immediate trade (trigger) → the real hourly settlement
job → playoffs → champion. It uses a test season set in the past with the global simulation clock placed before
it, so the draft is "pre-season" and settlement acts on ended weeks. **Run it before every beta-facing release.**

### Season player universe (who "exists" in a season)

`functions/playerUniverse.js`, built by `dataSync.js` on every sync for each **regular** season S. It writes
`pwhl_players/{S}_{playerId}` for the union below, so the app, the draft room, the bot engine and projections read
one complete list. The 2026-27 regular rosters were **empty** six days before the opener; the paired preseason
(345 players, incl. the 73 "Draftee" rookies) was the only source.

| Source (first match wins) | PWHL team (`current_team_id`, `team_id`, …) |
|---|---|
| `roster` — on S's regular roster | S team |
| `preseason` — on the paired preseason P only (P = the preseason starting latest before S: 11↔10, 8↔7, 5↔4, 1↔2) | P team while S has **0 final games**; after that **none (shows "FA")** |
| `game` — in a season-S box score only | team of the latest game |
| `retained` — was in S's feed, now in none | none (FA); **docs are never deleted** |
| `fantasy_roster` — on a fantasy roster of an S league, no S doc | none (FA); bio from the player's latest doc in any season |

- Copied rows carry only `BIO_FIELDS` — never stats. Team fields are always written explicitly (null for FA),
  because `DataContext` spreads the raw doc last and a stale `team_id` would otherwise win.
- Each doc has `universe { source, onRegularRoster, pwhlTeamId, lastSeenInFeedAt }`; `pwhl_seasons/{S}.universe`
  holds the counts. Camp invitees are included, with no label (CEO, 2026-11-28).
- UI: a player with no PWHL team shows team **FA** via `PwhlTeamLabel` (dashed grey chip). The league's fantasy
  availability "FA" stays a filled colour pill — same letters, visibly different.
- Safeguard in the app: Roster and Matchup never drop a rostered player with no doc in the season list; they show
  the name from any season's doc (else "Player {id}"), the slot's position, and team FA.

### DataContext "universe resolver" fallback

`DataContext.loadSeasonData(seasonId)` caches per-season players/teams/projections/games. Its non-obvious
behavior: **if the requested season has no players yet** (an upcoming season), it falls back to the most
recent prior *regular* season (`playoff === '0' && career === '1'`) and returns `resolvedSeasonId` plus
`isFallbackUniverse: true`. Consumers should respect those fields rather than assuming they got the season
they asked for.

**That rule exists once on each side.** Client: `resolveUniverseSeason(seasonId, seasons, hasPlayers)` in
`src/services/pwhlService.js` → `{ seasonId, isFallback }`, used by `DataContext`, `fetchDraftEligiblePlayers`,
`generateSeasonProjectionsClient` and `DataHub`. Server: the same function in `functions/universeSeason.js`, plus
`loadSeasonPlayerPool(db, seasonId)`, used by `generateSeasonProjections` and the bot draft engine. **Keep the two in
step** — `test-season-pool.js` runs both over the same cases. Do not write another inline copy.

Every reader uses **one season's pool**, never all of `pwhl_players`:

- The bot draft engine (`handleDraftStateChange`) reads only the league's season — `league.season_id`, or
  `app_settings/active_season` for leagues made by `createLeague`, which stores none — through that fallback. It
  dedupes by `player_id` and records the bare `player_id` in picks and rosters, never the `<season>_<player>` doc id.
- `submitDraftPick` reads the `<season>_<player>` doc for the league's season (then any season's doc by `player_id`)
  for the pick's position, and stores it on the pick as `position`. The fixed id ranges (8–11 D, 12–14 G) apply only to
  the engine's built-in `pwhl_N` scouting pool, used when a season pool is empty.

It intentionally keeps parallel `useRef` mirrors (`cacheRef`, `loadingStatesRef`) alongside React state —
the refs provide synchronous dedupe to prevent concurrent duplicate loads and render loops. Keep both in sync.

### Three-tier stats pipeline

Fantasy points can be computed three ways, in descending order of preference. `src/services/statsEngine.js`:

1. **`fetchDailyPlayerPointsFromSnapshot()`** — *primary.* Reads pre-computed points from the
   `daily_game_stats` collection written by Cloud Functions. Falls back to tier 2 when snapshots are absent
   (migration, or dates predating the pipeline).
2. **`fetchDailyPlayerPointsForWeek()`** — legacy client-side recompute of per-day points from raw game summaries.
3. **`fetchAggregatedStats(seasonId, cutoffDate, startDate)`** — cumulative season totals aggregated from raw
   `pwhl_game_summaries`, bounded by the simulation cutoff. Used for season-to-date views.

`fetchWeeklyPlayerPoints()` is the week-bounded variant. All of these clamp their end bound to
`min(weekEnd, simulatedDate)`.

Scoring is driven by a per-league scoring matrix (separate skater and goalie matrices), not hardcoded values.

Raw PWHL (HockeyTech) summary shape, which the aggregation code depends on:
- Skaters: `summary.home_team_lineup.players[]` / `summary.visitor_team_lineup.players[]`
- Goalies: `summary.goalies.home[]` / `summary.goalies.visitor[]` (`seconds` = TOI)
- Assists and PP/SH assists are **derived from `summary.goals[]`**, not present on the skater records

### Cloud Functions (`functions/`, Node 20)

Still on `firebase-functions` v4 with a mix of v1 (`functions.pubsub`, `functions.https.onCall`) and
v2 (`onDocumentWritten`) APIs. `functions/index.js` is ~3400 lines.

- `syncDailyData`, `settleMatchupWeeksScheduled` — scheduled pubsub jobs
- `liveGamePoller` (`livePoller.js`) — polls the HockeyTech feed during live games
- `onGameSummaryWritten` — writes `daily_game_stats` snapshots when a summary lands
- `onSimulationStateWritten`, `onLeagueSimulatedDateWritten` — drive the simulation game loop: advancing a
  clock resolves matchups, advances `currentWeek`, and updates team records
- `initializeTestEnvironment`, `deactivateSimulation`, `triggerSimulationDailySync`, `getSimulatedTime` — callable admin/sim controls
- `generateSeasonProjections` — callable projections generator

`dailyGameStats.js` holds the snapshot logic (`snapshotDailyGameStats`, `readDailyPoints`,
`calculateTeamWeekScore`, `getTeamActiveLineup`, `getLockedPlayerIds`). `utils.js#getSystemDate(leagueId)` is
the server-side counterpart to `getSimulatedDate()`.

### PWHL API access differs between client and server

- **Data sync runs on the server.** `functions/dataSync.js#runSync` syncs seasons, teams, rosters (`pwhl_players`),
  schedule, week maps, missing game summaries (capped per run — each write fires `onGameSummaryWritten`) and player
  stats. The nightly `syncDailyData` runs it for recent seasons; the Admin Panel **Sync** button calls the
  admin-only `runDataSync` callable, so it works on the deployed site. The old browser sync (`runFullSync`,
  `syncSeasons` … `syncPlayerStats`) is deleted — it re-downloaded every summary (it compared `status_value`,
  which is text like "Final", to `'4'`) and wrote a hard-coded `UPCOMING_SEASONS` list over the feed's real season
  dates (preseason 2026-06-01 instead of 2026-10-01).
- **Client** (`src/services/pwhlService.js`): `BASE_URL = '/api/pwhl/index.php'` is proxied to
  `lscluster.hockeytech.com` by the **Vite dev server only**; on Hosting these calls return the SPA's HTML. The
  remaining client feed calls (`fetchGameSummary` for the Data Hub viewer, player history) therefore only work under
  `npm run dev`.
- **Server** (`functions/hockeytech.js`, used by every function): uses the absolute `https://lscluster.hockeytech.com/feed/index.php` and works anywhere.

The feed sometimes wraps responses in a JSONP callback; `fetchFromApi` strips it with a regex before parsing.

#### Checking the feed is still intact

`node check-pwhl-feed.js` hits every endpoint this project consumes (`seasons`, `schedule`,
`teamsbyseason`, `roster`, `statviewtype` for both skaters and goalies, and `gc/gamesummary`) and asserts the
response shapes the ingestion actually depends on. It reads nothing from Firestore and needs no emulator, so
it is safe to run any time; it exits non-zero on failure, so it also works as a pre-deploy gate.

The point is the `gamesummary` check: it confirms `home_team_lineup.players[]`, `goalies.home[]`, the
`goals[]` array and the per-skater scoring fields are all still present. Those are what `statsEngine`
aggregates fantasy points from, and an upstream rename there would surface as quietly missing points rather
than an error.

**Season selection matters when reading the output.** Roster, stats and summaries only exist once a season is
under way, so checking them against an upcoming season reports empty data as though the feed were broken. The
script therefore runs structural checks against the newest season, data checks against the most recent season
that has *started*, and walks back through seasons until it finds a genuinely completed game for the summary
check. Empty `statviewtype` results are normal in pre-season and are not treated as failures.

### Firestore data model

PWHL reference data (read-mostly, synced from the feed): `pwhl_seasons`, `pwhl_teams`, `pwhl_players`,
`pwhl_games`, `pwhl_game_summaries`, `pwhl_player_stats`, `pwhl_season_player_stats`, `pwhl_projections/{seasonId}/player_projections`.

Computed: `daily_game_stats`.

Fantasy: `fantasy_leagues/{leagueId}` with subcollections `teams/{teamId}` (and nested
`daily_lineups/{date}`), `matchups`, `draft`, `waivers`, `waiver_claims`, `trades`.

Settings: `app_settings/active_season`, `admin_settings/simulation_state`. Users: `users/{uid}`.

**`leagues/` and `fantasy_leagues/` both exist in `firestore.rules`.** `fantasy_leagues` is current;
`leagues` is legacy. Write new code against `fantasy_leagues`.

### Service layer

`src/services/leagueService.js` (~1800 lines) is the transactional core — league/draft lifecycle, add/drop,
waivers, trades, roster moves, and daily lineups. Prefer its exported functions over writing Firestore
directly from components; several operations span multiple documents.

Date helpers live here too: `getLocalDateStr()` and `getPSTDateStr()`. **League days are PST-based** —
use `getPSTDateStr()` for anything keyed by game day (notably `daily_lineups/{date}` doc IDs).

### UI

`src/App.jsx` is the shell and does its own tab routing from a `currentTab` string synced to the URL — there
is no router. Valid tabs: `matchup`, `roster`, `players`, `standings`, `transactions`, `settings`, `manager`,
plus `draft_room`. `standings`/`transactions`/`settings`/`manager` all render `League` with a different
`initialTab`. Styling is **Tailwind via CDN `<script>` in `index.html`** — there is no Tailwind build step,
so no custom config or `@apply`.

### Product analytics

`src/services/analytics.js` wraps Firebase Analytics (GA4). Call `track(name, params)`; it never throws, does
nothing when Analytics is not enabled or the manager opted out (account menu → "Usage data"), and on localhost
only logs `[analytics] …` to the console unless `?analyticsDebug` is in the URL. **Params carry ids only — never
names, emails or free text.** Events: `sign_up`, `login`, `league_create`, `league_join`, `draft_pick`,
`lineup_change`, `add_drop`, `waiver_claim`, `trade_propose`, `trade_accept`/`trade_reject`, `matchup_view`.
Service-level events are logged in `leagueService.js` after the write succeeds, so every screen that calls the
service is covered. As of 2026-11-28 Google Analytics is **not yet enabled** for the project (no `measurementId`);
events queue locally and are dropped until it is.

## Conventions and gotchas

- **`season_id` is stored inconsistently as both string and number.** Every query uses
  `where('season_id', 'in', [String(id), Number(id)])`. Follow that pattern or you will silently get zero results.
- **Positions are normalized to exactly `F` / `D` / `G`.** `normalizePosition()` is duplicated in **five**
  places — `src/contexts/DataContext.jsx`, `src/services/statsEngine.js`, `src/services/pwhlService.js`,
  `functions/dailyGameStats.js`, and `functions/index.js:1882`. Change all of them together. Note
  `functions/index.js` *also* imports the `dailyGameStats` copy as `normPos` (line 6) while defining its own,
  so check which one a given call site uses.
- **Player IDs are strings.** Sources vary between `player_id` and `id`; normalize with `String()` and dedupe
  (duplicate player records exist — hence `scripts/mergeDuplicates.js`).
- Admin access: `AuthContext` grants admin to the hardcoded email `justinemerick79@gmail.com`, otherwise
  checks `users/{uid}.role === 'admin'`.
- The Firebase web config in `src/firebase.js` is intentionally committed — those are public client
  identifiers; access control lives in `firestore.rules`.

### Linting

`eslint.config.js` defines four environments; match new files to the right one:

| Pattern | Environment |
|---|---|
| `src/**/*.{js,jsx}` | browser globals, ESM, JSX, React hooks + refresh rules |
| `src/contexts/**` | as above, but `react-refresh/only-export-components` off (see below) |
| `*.js` (root), `scripts/**/*.js` | Node globals, ESM — run under `npx tsx` / `node` |
| `functions/**/*.js`, `**/*.cjs` | Node globals, **CommonJS** |
| `dist`, `dist-ssr`, `scratch`, `node_modules` | ignored |

Getting this wrong is what previously made lint unusable: browser globals were applied to every file, so the
Node scripts produced a flood of spurious `'process' is not defined`. `no-unused-vars` is tuned project-wide
to allow an unused `catch (e)` binding and `_`-prefixed parameters.

**`npm run lint` reports 8 findings, down from 415, and all 8 are accepted (below). Treat lint as a clean
gate: any new finding is yours.** Every other rule is at zero, and several mean a real bug if they fire —
`no-undef` (a `ReferenceError` waiting to happen), `react-hooks/rules-of-hooks` (hook-order corruption),
`react-hooks/refs` (impure render), `react-hooks/immutability` (use before declaration),
`react-hooks/exhaustive-deps` (stale closure).

**The 8 `set-state-in-effect` findings are accepted, not outstanding.** They are all the fetch-in-effect
pattern — setting a loading flag before an `await`, or calling a function that does. The rule's prescribed
fix is to stop fetching in effects, which needs a data-fetching library (TanStack Query/SWR) or React 19
`use()` + Suspense; there is no local edit that satisfies it. Do not scatter `eslint-disable` lines to
lower the number, and do not "fix" one of these in isolation. If a fetching library is ever adopted, these
are the call sites to migrate: `App.jsx` (2), `Matchup.jsx` (2), `Players.jsx` (2), `Roster.jsx`,
`PlayerCardModal.jsx`.

**Do not grow this list.** A refresh indicator was briefly added to Matchup as a flag set inside its effect,
taking the count to 9; it was reworked into derived state instead (see below) to keep the gate at 8. When new
work seems to need a loading flag in an effect, derive it from a stamp rather than adding to this group.

`react-refresh/only-export-components` is switched off for `src/contexts/**`. Those files pair a provider
component with its consumer hook, which is the standard context idiom; the rule only affects Fast Refresh
ergonomics in dev. Satisfying it properly would mean splitting each context into three files (context
object / provider / hook) and updating 14 import sites.

### Keeping exhaustive-deps at zero

Effects that call a function defined in the component body need that function wrapped in `useCallback`,
otherwise listing it as a dep re-runs the effect every render. `App.jsx`, `DraftRoom.jsx`, `League.jsx` and
`Players.jsx` all follow this shape now.

Two things that bit during that work, worth repeating:

- **Let the rule report the closure set.** Wrap a new callback with `[]` first and read what the rule says
  is missing, rather than inferring it. That caught `getTopAvailablePlayer` reading `activeSeasonId`, which
  its own comment implied it did not.
- **Order matters once a function becomes a `useCallback`.** A `const` cannot be referenced above its
  declaration, so `handleSetActiveLeague` had to move above `fetchUserLeagues`. A hoisted `function`
  declaration hides this until you convert it.

Before adding a dep, check it cannot loop: either the effect never writes that value, or a guard stops the
second pass. `Matchup.jsx`'s date-sync effect depends on `selectedMatchupDate`, which it sets — the
`lastSimDateStrRef` / `lastLeagueIdRef` guards are what make that safe, so do not remove them.

### Mirroring Firestore data into state

Several screens have the same latent bug shape: state fetched for league A is still in state when
`activeLeagueId` has already become B, so the UI serves the previous league's data until the new read
lands — and if the new read finds nothing, it serves it indefinitely. `TimeTravelContext` and `LeagueHub` both stamp the
fetched data with the league it came from and derive the exposed values, discarding anything that does not
match the active league; copy that shape rather than resetting state in a guard clause.

Two things that shape carries with it, both handled in `LeagueHub`: write **every** field on each fetch
(assigning only when found is what let a stale value persist indefinitely), and stamp the attempt in the
`catch` too — otherwise a derived "still loading" flag never clears. Clearing stale data also means a
selected-but-unloaded league needs its own loading state, distinct from "nothing selected".

Prefer deriving over mirroring: `Matchup.jsx`'s `seasonWeeks` is a `useMemo` over the season doc, not an
effect that copies into state. The same stamp trick also covers "is this view refreshing?": `Matchup.jsx`
builds a `matchupDataKey` from league + date + week, the fetch stamps `loadedMatchupKey` in its `finally`
(after the awaits, so it is not a synchronous setState in the effect body), and the indicator is derived as
`loadedMatchupKey !== matchupDataKey`. Stamping in `finally` matters: on `catch` alone a failed load would
leave the indicator spinning forever. Similarly `Players.jsx` derives `effectiveStatViewMode` during render
instead of correcting `statViewMode` in an effect.

When a component needs to bail out early, the guard must sit **below every hook call**, with the effect
itself bailing internally. `PlayerCardModal.jsx` is the worked example of this shape.

**`no-undef` in `src/` indicates a real `ReferenceError`, not lint noise.** Treat any occurrence as a bug.

All known cases are fixed: three missing imports (`useMemo`, `updateDoc`,
`generateSeasonProjectionsClient`), and `League.jsx`'s propose-trade modal, where the JSX referenced a
non-existent `submittingTrade` (the state is `tradeSubmitting`) and called a `handleProposeTrade` that was
never written.

### Scripts

`scripts/importDraftData.js` and `scripts/mergeDuplicates.js` are one-off maintenance scripts.
`scripts/wipeLeagues.js` is an abandoned 12-line stub — it has no logic and carries a stale Firebase config
from a different project (messagingSenderId `148303038668`, not this project's `502197146749`); it does
nothing if run, and is a deletion candidate. `functions/testDates.js` and `functions/checkRosterDateBug.js` are date-bug investigation scratch,
not part of the deployed bundle. `scratch/` is gitignored.
