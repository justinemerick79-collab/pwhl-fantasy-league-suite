/**
 * check-pwhl-feed.js
 *
 * Health check for the upstream PWHL (HockeyTech) feed.
 *
 * Hits every endpoint this project consumes and asserts the response shapes the
 * ingestion code actually depends on. Catches upstream changes — a renamed
 * field, an emptied array, a dead endpoint — that would otherwise surface as
 * silently missing data rather than an error.
 *
 * Read-only: touches no Firestore and no emulator. Safe to run any time.
 *
 *   node check-pwhl-feed.js
 *
 * Exits non-zero if any check fails, so it can gate a deploy.
 */
const API_KEY = "446521baf8c38984";
const CLIENT_CODE = "pwhl";
// Absolute URL, as the Cloud Functions use. The client's relative /api/pwhl path
// only resolves through the Vite dev proxy.
const BASE_URL = "https://lscluster.hockeytech.com/feed/index.php";

async function fetchFromApi(params) {
  const url = new URL(BASE_URL);
  url.searchParams.append("key", API_KEY);
  url.searchParams.append("client_code", CLIENT_CODE);
  url.searchParams.append("fmt", "json");
  for (const [k, v] of Object.entries(params)) url.searchParams.append(k, v);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const text = await res.text();
  // The feed sometimes wraps responses in a JSONP callback.
  let json = text;
  if (text.startsWith("typeof ") || text.indexOf("(") > -1) {
    const m = text.match(/^[^{]*({.*})[^}]*$/s);
    if (m) json = m[1];
  }
  try {
    return JSON.parse(json);
  } catch {
    throw new Error(`response was not JSON (first 80 chars: ${text.slice(0, 80)})`);
  }
}

const results = [];
async function check(name, params, assert) {
  try {
    const data = await fetchFromApi(params);
    const detail = assert(data);
    results.push({ name, ok: true, detail });
    console.log(`✅ ${name.padEnd(34)} ${detail}`);
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
    console.log(`❌ ${name.padEnd(34)} ${err.message}`);
  }
}

function need(cond, msg) { if (!cond) throw new Error(msg); }

const run = async () => {
  console.log("Checking the PWHL feed against the shapes this project consumes...\n");

  // 1. seasons — drives which seasons syncDailyData ingests
  let seasonId = null, dataSeasonId = null, newestSeason = null, dataSeason = null;
  let gameId = null, firstTeamId = 1, gameSeasonName = null, allSeasons = [];
  await check("seasons", { feed: "modulekit", view: "seasons" }, (d) => {
    const rows = d?.SiteKit?.Seasons;
    need(Array.isArray(rows) && rows.length, "SiteKit.Seasons missing or empty");
    need(rows[0].season_id !== undefined, "season row has no season_id");
    need(rows[0].start_date !== undefined, "season row has no start_date (the date-based filter needs this)");
    allSeasons = rows;
    const sorted = [...rows].sort((a, b) => new Date(b.start_date) - new Date(a.start_date));
    newestSeason = sorted[0];
    seasonId = String(newestSeason.season_id);
    // Roster, stats and summaries only exist once a season is under way. Checking
    // them against an upcoming season reports empty data as though the feed were
    // broken, so pick the most recent season that has actually started.
    const started = sorted.find((x) => new Date(x.start_date) <= new Date());
    dataSeason = started || sorted[0];
    dataSeasonId = String(dataSeason.season_id);
    return `${rows.length} seasons; newest "${newestSeason.season_name}" (id ${seasonId})`;
  });

  if (!seasonId) {
    console.log("\n⚠️  Cannot continue without a season id.");
    process.exit(1);
  }
  console.log(`   (data checks use "${dataSeason.season_name}", id ${dataSeasonId} — the most recent season under way)\n`);

  // 2. schedule — pwhl_games
  await check("schedule", { feed: "modulekit", view: "schedule", season_id: seasonId }, (d) => {
    const rows = d?.SiteKit?.Schedule;
    need(Array.isArray(rows), "SiteKit.Schedule missing");
    const withId = rows.filter((g) => g.game_id);
    need(withId.length > 0 || rows.length === 0, "schedule rows have no game_id");
    return `${rows.length} games`;
  });

  // 3. teamsbyseason — pwhl_teams
  await check("teamsbyseason", { feed: "modulekit", view: "teamsbyseason", season_id: dataSeasonId }, (d) => {
    const rows = d?.SiteKit?.Teamsbyseason;
    need(Array.isArray(rows) && rows.length, "SiteKit.Teamsbyseason missing or empty");
    firstTeamId = rows[0].id || rows[0].team_id || 1;
    return `${rows.length} teams`;
  });

  // Find a genuinely completed game for the summary check. The current season may
  // not have played one yet (pre-season, or a season still to start), so walk back
  // through seasons until a final game turns up — the summary shape is what all
  // fantasy scoring is aggregated from, so it is worth actually exercising.
  {
    const ordered = allSeasons.slice().sort((a, b) => new Date(b.start_date) - new Date(a.start_date));
    let searched = 0;
    for (const season of ordered) {
      searched++;
      let rows = [];
      try {
        const d = await fetchFromApi({ feed: "modulekit", view: "schedule", season_id: String(season.season_id) });
        rows = d?.SiteKit?.Schedule || [];
      } catch { /* try the next season */ }
      const final = rows.filter((g) => String(g.game_status) === "4" || String(g.status) === "4");
      if (final.length) {
        gameId = final[final.length - 1].game_id;
        gameSeasonName = season.season_name;
        console.log(`✅ ${"completed game lookup".padEnd(34)} game ${gameId} from "${season.season_name}" (searched ${searched} season${searched === 1 ? "" : "s"})`);
        results.push({ name: "completed game lookup", ok: true, detail: `game ${gameId}` });
        break;
      }
    }
    if (!gameId) {
      console.log(`❌ ${"completed game lookup".padEnd(34)} no final game found in any season`);
      results.push({ name: "completed game lookup", ok: false, detail: "no final game in any season" });
    }
  }

  // 4. roster — pwhl_players
  await check("roster", { feed: "modulekit", view: "roster", season_id: dataSeasonId, teamId: undefined, team_id: firstTeamId }, (d) => {
    const rows = d?.SiteKit?.Roster;
    need(Array.isArray(rows), "SiteKit.Roster missing");
    return `${rows.length} players (team 1)`;
  });

  // 5 & 6. stats — pwhl_season_player_stats
  await check("statviewtype topscorers", { feed: "modulekit", view: "statviewtype", type: "topscorers", season_id: dataSeasonId, first: 0, limit: 500 }, (d) => {
    const rows = d?.SiteKit?.Statviewtype;
    need(Array.isArray(rows), "SiteKit.Statviewtype missing");
    return `${rows.length} skaters`;
  });
  await check("statviewtype topgoalies", { feed: "modulekit", view: "statviewtype", type: "topgoalies", season_id: dataSeasonId, first: 0, limit: 100 }, (d) => {
    const rows = d?.SiteKit?.Statviewtype;
    need(Array.isArray(rows), "SiteKit.Statviewtype missing");
    return `${rows.length} goalies`;
  });

  // 7. game summary — the shape statsEngine aggregates fantasy points from
  if (gameId) {
    await check(`gamesummary (${gameSeasonName})`, { feed: "gc", tab: "gamesummary", game_id: gameId, site_id: 0, lang: "en" }, (d) => {
      const s = d?.GC?.Gamesummary;
      need(s, "GC.Gamesummary missing");
      need(s.home_team_lineup && Array.isArray(s.home_team_lineup.players), "home_team_lineup.players missing — skater aggregation reads this");
      need(s.visitor_team_lineup && Array.isArray(s.visitor_team_lineup.players), "visitor_team_lineup.players missing");
      need(s.goalies && (s.goalies.home !== undefined), "goalies.home missing — goalie aggregation reads this");
      need(Array.isArray(s.goals), "goals[] missing — assists and PP/SH points are derived from it");
      const skater = s.home_team_lineup.players[0] || {};
      const fields = ["goals", "assists", "plusminus", "shots_on"].filter((f) => skater[f] === undefined);
      need(fields.length === 0, `skater record missing scoring fields: ${fields.join(", ")}`);
      return `lineups + goalies + ${s.goals.length} goals, scoring fields present`;
    });
  } else {
    console.log("⚠️  gamesummary                        skipped — no completed game found this season");
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("FAILED: " + failed.map((f) => f.name).join(", "));
    process.exit(1);
  }
  console.log("Feed contract intact.");
};

run().catch((e) => { console.error("Checker crashed:", e); process.exit(1); });
