/**
 * Season player universe — every player who can matter for a regular season S, written
 * to pwhl_players/{S}_{playerId} so the app, the draft room, the bot engine and
 * projections all read one complete list. Plan: Drive, folder 05 / CEO decisions
 * 2026-11-28. Built by functions/dataSync.js on every sync.
 *
 * Union, in priority order (a player is taken from the first source that has them):
 *   roster          on S's regular-season roster              → S team
 *   preseason       on the paired preseason P's roster only   → P team while S has 0 games played,
 *                                                                 then no team ("FA")
 *   game            in a season-S box score, on no roster      → team from the latest game
 *   retained        already in S's universe, now in no feed    → doc kept, no team (FA)
 *   fantasy_roster  on a fantasy roster of a season-S league,  → bio from the player's latest doc in any
 *                   with no S doc                                season, no team (FA)
 *
 * Rules: never delete a player doc; never copy stats from another season (only BIO_FIELDS).
 */
const { Timestamp } = require("firebase-admin/firestore");

// Profile fields copied from a preseason row or an older doc. Never stats.
const BIO_FIELDS = [
  "id", "person_id", "player_id", "playerId", "first_name", "last_name", "name", "display_name", "phonetic_name",
  "position", "position_id", "shoots", "height", "weight", "h", "w", "height_hyphenated", "birthdate", "rawbirthdate",
  "birthdate_year", "hometown", "homeprov", "homecntry", "homeplace", "birthtown", "birthprov", "birthcntry",
  "birthplace", "player_image", "tp_jersey_number", "rookie", "isRookie", "draft_status", "draftinfo", "draftInfo",
  "status", "active", "hidden", "veteran_status", "veteran_description", "grad_year", "nhlteam",
];
// Team fields the app reads; always set explicitly so a stale value never shows.
const TEAM_FIELDS = ["current_team_id", "team_id", "team_name", "latest_team_id", "current_team", "division"];

const isRegularSeason = (s) => String(s?.career) === "1" && String(s?.playoff) === "0";
const isPreseason = (s) => String(s?.career) === "0" && String(s?.playoff) === "0";

/** The preseason that starts latest on or before a regular season's start (11→10, 8→7, 5→4, 1→2). */
function pairPreseason(feedSeasons, regular) {
  const start = Date.parse(regular?.start_date);
  if (!isRegularSeason(regular) || Number.isNaN(start)) return null;
  return feedSeasons
    .filter(s => isPreseason(s) && Date.parse(s.start_date) <= start)
    .sort((a, b) => Date.parse(b.start_date) - Date.parse(a.start_date))[0] || null;
}

function pick(row, fields) {
  const out = {};
  for (const f of fields) if (row && row[f] !== undefined) out[f] = row[f];
  return out;
}

const pidOf = (row) => String(row?.player_id || row?.id || row?.person_id || "");

/**
 * Pure merge — no I/O, so it can be tested on its own.
 * @param {object} p
 * @param {string} p.seasonId
 * @param {Map<string,{row:object, teamId:string, teamName?:string}>} p.regular
 * @param {Map<string,{row:object, teamId:string, teamName?:string}>} p.preseason
 * @param {number} p.gamesPlayed   final games in S so far
 * @param {Map<string,{name:string, teamId:string|null}>} p.gamePlayers
 * @param {Map<string,object>} p.existing   current S docs by player id
 * @param {Set<string>} p.fantasyIds        player ids on fantasy rosters of S leagues
 * @param {Map<string,object>} p.olderDocs  latest doc in any season, for fantasy ids with no S doc
 * @returns {{ docs: Map<string,object>, counts: Record<string,number> }}
 */
function planUniverse({ seasonId, regular, preseason, gamesPlayed, gamePlayers = new Map(), existing = new Map(), fantasyIds = new Set(), olderDocs = new Map(), nowMs = Date.now() }) {
  const S = String(seasonId);
  const now = Timestamp.fromMillis(nowMs);
  const docs = new Map();
  const counts = { roster: 0, preseason: 0, game: 0, retained: 0, fantasy_roster: 0, pwhlFA: 0 };
  const teamFields = (teamId, teamName) => ({
    current_team_id: teamId || null, team_id: teamId || null, latest_team_id: teamId || null,
    team_name: teamId ? (teamName || null) : null, current_team: teamId || null, division: null,
  });
  const add = (pid, base, teamId, teamName, source, seenInFeed) => {
    const prev = existing.get(pid)?.universe || {};
    docs.set(pid, {
      ...base, player_id: pid, season_id: S, ...teamFields(teamId, teamName),
      universe: { source, onRegularRoster: source === "roster", pwhlTeamId: teamId || null,
        lastSeenInFeedAt: seenInFeed ? now : (prev.lastSeenInFeedAt || null), updatedAt: now },
    });
    counts[source]++;
    if (!teamId) counts.pwhlFA++;
  };

  for (const [pid, r] of regular) add(pid, { ...r.row }, r.teamId, r.teamName, "roster", true);
  for (const [pid, r] of preseason) {
    if (docs.has(pid)) continue;
    const keepTeam = gamesPlayed === 0;
    add(pid, pick(r.row, BIO_FIELDS), keepTeam ? r.teamId : null, keepTeam ? r.teamName : null, "preseason", true);
  }
  for (const [pid, g] of gamePlayers) {
    if (docs.has(pid)) continue;
    const base = existing.get(pid) ? pick(existing.get(pid), BIO_FIELDS) : { name: g.name };
    add(pid, base, g.teamId, null, "game", false);
  }
  for (const [pid, doc] of existing) {
    if (docs.has(pid)) continue;
    // "retained" = was in this season's feed, now gone. A player first added only
    // because a fantasy team rosters her keeps that label.
    const source = doc.universe?.source === "fantasy_roster" ? "fantasy_roster" : "retained";
    add(pid, pick(doc, BIO_FIELDS), null, null, source, false);
  }
  for (const pid of fantasyIds) {
    if (docs.has(pid)) continue;
    add(pid, pick(olderDocs.get(pid) || { name: `Player ${pid}` }, BIO_FIELDS), null, null, "fantasy_roster", false);
  }
  return { docs, counts };
}

/** Rosters of one season from the feed: Map pid → { row, teamId, teamName }. */
async function fetchSeasonRosters(api, seasonId, sleepMs = 150) {
  const out = new Map();
  const teams = (await api({ feed: "modulekit", view: "teamsbyseason", season_id: String(seasonId) }))?.SiteKit?.Teamsbyseason || [];
  for (const t of teams) {
    if (!t.id) continue;
    if (sleepMs) await new Promise(r => setTimeout(r, sleepMs));
    const roster = (await api({ feed: "modulekit", view: "roster", season_id: String(seasonId), team_id: t.id }))?.SiteKit?.Roster || [];
    for (const row of roster) {
      const pid = pidOf(row);
      if (pid) out.set(pid, { row, teamId: String(t.id), teamName: t.name || t.nickname || null });
    }
  }
  return { teams, rosters: out };
}

/**
 * Build and write the universe for regular season S. `regular` and `games` come from the
 * season sync that just ran; this adds the preseason, box-score players, retained docs and
 * fantasy-rostered players.
 */
async function buildSeasonUniverse(db, season, feedSeasons, { api, log = console.log, regular, games, sleepMs = 150, nowMs = Date.now() }) {
  const S = String(season.season_id);
  const pre = pairPreseason(feedSeasons, season);
  const preseason = pre ? (await fetchSeasonRosters(api, pre.season_id, sleepMs)).rosters : new Map();
  const gamesPlayed = games.filter(g => String(g.status) === "4").length;

  const existingSnap = await db.collection("pwhl_players").where("season_id", "in", [S, Number(S)]).get();
  const existing = new Map(existingSnap.docs.map(d => [pidOf(d.data()) || d.id.split("_").slice(1).join("_"), d.data()]));

  // Players seen in season-S box scores (live scoring), with the team of their latest game.
  const gamePlayers = new Map();
  const boxes = await db.collection("game_box_scores").where("seasonId", "==", S).get();
  const gameTeams = new Map(games.map(g => [String(g.game_id), { home: String(g.home_team), visitor: String(g.visiting_team), date: g.date_played || "" }]));
  const sortedBoxes = boxes.docs.map(d => d.data()).sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  for (const b of sortedBoxes) {
    const gt = gameTeams.get(String(b.gameId)) || {};
    for (const kind of ["skaters", "goalies"]) {
      for (const [pid, st] of Object.entries(b[kind] || {})) gamePlayers.set(pid, { name: st.name, teamId: st.team === "home" ? gt.home || null : gt.visitor || null });
    }
  }

  // Player ids on fantasy rosters of leagues in season S.
  const fantasyIds = new Set();
  const leagues = await db.collection("fantasy_leagues").where("season_id", "in", [S, Number(S)]).get();
  for (const L of leagues.docs) {
    const teams = await L.ref.collection("teams").get();
    for (const t of teams.docs) for (const pid of t.data().players || []) fantasyIds.add(String(pid));
  }
  const olderDocs = new Map();
  const missing = [...fantasyIds].filter(pid => !existing.has(pid) && !gamePlayers.has(pid));
  for (const pid of missing) {
    const snap = await db.collection("pwhl_players").where("player_id", "in", [pid, Number(pid)]).get();
    const latest = snap.docs.map(d => d.data()).sort((a, b) => Number(b.season_id) - Number(a.season_id))[0];
    if (latest) olderDocs.set(pid, latest);
  }

  const { docs, counts } = planUniverse({ seasonId: S, regular, preseason, gamesPlayed, gamePlayers, existing, fantasyIds, olderDocs, nowMs });
  const writes = [...docs].map(([pid, data]) => [db.collection("pwhl_players").doc(`${S}_${pid}`), data]);
  for (let i = 0; i < writes.length; i += 450) {
    const batch = db.batch();
    for (const [ref, data] of writes.slice(i, i + 450)) batch.set(ref, data, { merge: true });
    await batch.commit();
  }
  const summary = { preseasonId: pre ? String(pre.season_id) : null, regularGamesPlayed: gamesPlayed, total: docs.size, ...counts, builtAt: Timestamp.fromMillis(nowMs) };
  await db.collection("pwhl_seasons").doc(S).set({ universe: summary }, { merge: true });
  log(`  universe ${docs.size} players (${counts.roster} roster, ${counts.preseason} preseason${pre ? ` from season ${pre.season_id}` : ""}, ${counts.game} from games, ${counts.retained} retained, ${counts.fantasy_roster} fantasy-rostered; ${counts.pwhlFA} with no PWHL team)`);
  return summary;
}

module.exports = { planUniverse, pairPreseason, buildSeasonUniverse, fetchSeasonRosters, isRegularSeason, BIO_FIELDS, TEAM_FIELDS };
