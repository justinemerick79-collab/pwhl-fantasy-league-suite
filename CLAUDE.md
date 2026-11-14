# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

PWHL fantasy hockey league suite — a React + Vite SPA on Firebase (Firestore, Auth, Cloud Functions, Hosting).
Firebase project: `pwhl-fantasy-mobile-26`. Live at https://pwhl-fantasy-mobile-26.web.app.

Note `package.json` is still named `temp_web` and `README.md` is the stock Vite template; neither reflects the project.

## Commands

```bash
npm run dev        # Vite dev server — REQUIRED for any live PWHL API work (see API proxy below)
npm run build      # Vite build to dist/
npm run lint       # eslint (~233 pre-existing findings in app code — see Linting below)
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
standalone end-to-end scripts that drive the **Firebase emulator** (auth on `127.0.0.1:9099`). Run one at a time:

```bash
firebase emulators:start          # separate terminal; firebase.json has no emulators block, so ports are CLI defaults
npx tsx test-matchup-resolution.js
```

Each script sets up mock leagues/teams/players, manipulates the simulation clock, asserts an outcome, then
cleans up its own documents. `test-matchup-resolution.js` is the best reference for the full game-loop flow.

To point the browser at the local Functions emulator, append `?useEmulator` to the dev URL or set
`localStorage.useEmulator = 'true'` — see the guard at the bottom of `src/firebase.js`. Firestore and Auth
always hit production from the browser; only Functions are redirected.

## Architecture

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

`TimeTravelContext` also opportunistically calls `processWaivers()` and `processAcceptedTrades()` on every
active-league snapshot, so league-doc writes can trigger transaction processing as a side effect.

Services that need simulation state outside React re-read it from Firestore via their own local
`checkIsSimulation()` helpers (in `statsEngine.js` and `pwhlService.js`), which read
`localStorage.pwhl_active_league`. That key is the bridge between the React context and the service layer.

### DataContext "universe resolver" fallback

`DataContext.loadSeasonData(seasonId)` caches per-season players/teams/projections/games. Its non-obvious
behavior: **if the requested season has no players yet** (an upcoming season), it falls back to the most
recent prior *regular* season (`playoff === '0' && career === '1'`) and returns `resolvedSeasonId` plus
`isFallbackUniverse: true`. Consumers should respect those fields rather than assuming they got the season
they asked for.

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

- **Client** (`src/services/pwhlService.js`): `BASE_URL = '/api/pwhl/index.php'`, proxied to
  `lscluster.hockeytech.com` by the **Vite dev server only** (`vite.config.js`). Firebase Hosting rewrites
  `**` → `/index.html` and has no `/api` rewrite, so on the deployed site these calls return the SPA's HTML
  instead of JSON. The functions that hit the live feed — `syncSeasons`, `syncTeams`, `syncRoster`,
  `syncSchedule`, `syncPlayerStats`, `fetchGameSummary`, and `runFullSync` — therefore **only work under
  `npm run dev`**. They are invoked from `AdminPanel` / `DataHub`. Production ingestion runs through Cloud
  Functions instead.
- **Server** (`functions/livePoller.js`): uses the absolute `https://lscluster.hockeytech.com/feed/index.php` and works anywhere.

The feed sometimes wraps responses in a JSONP callback; `fetchFromApi` strips it with a regex before parsing.

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
| `*.js` (root), `scripts/**/*.js` | Node globals, ESM — run under `npx tsx` / `node` |
| `functions/**/*.js`, `**/*.cjs` | Node globals, **CommonJS** |
| `dist`, `dist-ssr`, `scratch`, `node_modules` | ignored |

Getting this wrong is what previously made lint unusable: browser globals were applied to every file, so the
Node scripts produced a flood of spurious `'process' is not defined`. `no-unused-vars` is tuned project-wide
to allow an unused `catch (e)` binding and `_`-prefixed parameters.

`npm run lint` still reports ~233 **genuine** pre-existing findings, so it is not yet a clean gate — judge new
code on its own diff. The bulk is ~172 `no-unused-vars` (mostly unused imports, e.g. leftover `lucide-react`
icons and the no-longer-needed React 19 default import). More serious clusters worth fixing deliberately:
9 `react-hooks/rules-of-hooks`, 13 `react-hooks/set-state-in-effect`, and 13 `react-hooks/exhaustive-deps`.

**`no-undef` in `src/` indicates a real `ReferenceError`, not lint noise.** Treat any occurrence as a bug.

One known case remains: `handleProposeTrade` and `submittingTrade` are referenced by the propose-trade
modal's JSX in `League.jsx` (lines 1582-1650) but defined nowhere in the file, so rendering that modal
throws. It looks like an unfinished refactor — the handler and its submitting state still need to be
written. (Three earlier cases — missing `useMemo`, `updateDoc`, and `generateSeasonProjectionsClient`
imports — have been fixed.)

### Scripts

`scripts/importDraftData.js`, `scripts/mergeDuplicates.js`, `scripts/wipeLeagues.js` are one-off maintenance
scripts. `functions/testDates.js` and `functions/checkRosterDateBug.js` are date-bug investigation scratch,
not part of the deployed bundle. `scratch/` is gitignored.
