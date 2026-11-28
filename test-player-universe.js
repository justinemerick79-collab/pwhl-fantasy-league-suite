/**
 * test-player-universe.js
 *
 * Season player universe (functions/playerUniverse.js, run by functions/dataSync.js):
 * regular rosters + the paired preseason + box-score, retained and fantasy-rostered
 * players, with the CEO's team rules. Drives the real runSync through a stubbed feed
 * whose rosters and schedule change between runs. Emulator only; removes what it wrote.
 *
 *   firebase emulators:exec --only functions,firestore,auth "npx tsx test-player-universe.js"
 */
import { createRequire } from "module";
import { requireEmulator } from "./test-support.js";

requireEmulator("test-player-universe.js");
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || "pwhl-fantasy-mobile-26";
const require = createRequire(import.meta.url);
const { runSync } = require("./functions/dataSync.js");
const fnRequire = createRequire(new URL("./functions/index.js", import.meta.url));
const { initializeApp } = fnRequire("firebase-admin/app");
const { getFirestore } = fnRequire("firebase-admin/firestore");
const db = getFirestore(initializeApp({ projectId: "pwhl-fantasy-mobile-26" }, "test-player-universe"));

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "✅" : "❌"} ${label}`); if (!ok) failures++; };

const REG = "9011", PRE = "9010", OLD = "9008";
const player = (id, first, last, pos, extra = {}) => ({ id, player_id: id, first_name: first, last_name: last, position: pos, status: "Signed", ...extra });

// The stub feed. Tests edit `feed` between runs.
const feed = {
  seasons: [
    { season_id: REG, season_name: "Test Regular", career: "1", playoff: "0", start_date: "2030-12-04", end_date: "2031-04-19" },
    { season_id: PRE, season_name: "Test Preseason", career: "0", playoff: "0", start_date: "2030-10-01", end_date: "2030-11-30" },
  ],
  teams: { [REG]: [{ id: "1", name: "Boston" }, { id: "2", name: "Montréal" }], [PRE]: [{ id: "1", name: "Boston" }, { id: "2", name: "Montréal" }] },
  rosters: {
    [PRE]: { "1": [player("p1", "Ada", "One", "F"), player("p2", "Bea", "Two", "D", { status: "Camp Invitee" })],
             "2": [player("p3", "Cy", "Three", "G"), player("p4", "Di", "Four", "F", { status: "Draftee", rookie: "1" })] },
    [REG]: { "1": [], "2": [] },
  },
  schedule: { [REG]: [{ game_id: "g1", season_id: REG, date_played: "2030-12-05", status: "1", home_team: "1", visiting_team: "2" }], [PRE]: [] },
};
const api = async (q) => {
  if (q.view === "seasons") return { SiteKit: { Seasons: feed.seasons } };
  if (q.view === "teamsbyseason") return { SiteKit: { Teamsbyseason: feed.teams[q.season_id] || [] } };
  if (q.view === "roster") return { SiteKit: { Roster: feed.rosters[q.season_id]?.[q.team_id] || [] } };
  if (q.view === "schedule") return { SiteKit: { Schedule: feed.schedule[q.season_id] || [] } };
  if (q.view === "statviewtype") return { SiteKit: { Statviewtype: [] } };
  return null;
};
const sync = () => runSync(db, { target: REG, api, sleepMs: 0, maxSummaries: 0, log: () => {} });
const P = async (pid) => (await db.collection("pwhl_players").doc(`${REG}_${pid}`).get()).data();

try {
  console.log("\nPRE-OPENER: regular rosters empty, 0 games played");
  await sync();
  for (const [pid, team] of [["p1", "1"], ["p2", "1"], ["p3", "2"], ["p4", "2"]]) {
    const d = await P(pid);
    check(d?.current_team_id === team && d.universe.source === "preseason", `${d?.first_name} ${d?.last_name} is in the season on her preseason team ${team}`);
  }
  check((await P("p4"))?.status === "Draftee", "a draftee rookie is draftable before she is on a regular roster");
  const u1 = (await db.collection("pwhl_seasons").doc(REG).get()).data().universe;
  check(u1.preseasonId === PRE && u1.total === 4 && u1.preseason === 4, `season summary: paired with preseason ${u1.preseasonId}, ${u1.total} players`);

  console.log("\nREGULAR ROSTERS FILLING, still 0 games");
  feed.rosters[REG] = { "1": [player("p1", "Ada", "One", "F")], "2": [player("p2", "Bea", "Two", "D"), player("p5", "Eve", "Five", "F")] };
  await sync();
  check((await P("p2")).current_team_id === "2" && (await P("p2")).universe.source === "roster", "a player on both rosters takes her regular-season team (Bea: 1 → 2)");
  check((await P("p3")).current_team_id === "2" && (await P("p3")).universe.source === "preseason", "a preseason-only player keeps her preseason team while 0 games are played");
  check((await P("p5"))?.universe.source === "roster", "a player signed after the preseason is added");

  console.log("\nFIRST REGULAR GAME FINAL");
  feed.schedule[REG][0].status = "4";
  await sync();
  for (const pid of ["p3", "p4"]) {
    const d = await P(pid);
    check(d.current_team_id === null && d.team_id === null && d.universe.source === "preseason", `${d.first_name} ${d.last_name} (preseason only) now shows no PWHL team (FA)`);
  }
  check((await P("p1")).current_team_id === "1", "a rostered player keeps her team");

  console.log("\nSAFEGUARDS");
  // Ada disappears from every feed.
  feed.rosters[REG]["1"] = [];
  feed.rosters[PRE]["1"] = feed.rosters[PRE]["1"].filter(p => p.player_id !== "p1");
  // A fantasy league in this season rosters "p9", who only has a doc from an older season (with stats).
  await db.collection("pwhl_players").doc(`${OLD}_p9`).set({ player_id: "p9", season_id: OLD, first_name: "Gia", last_name: "Nine", position: "D", points: 41, gp: 30, current_team_id: "1" });
  const L = db.collection("fantasy_leagues").doc("test_universe_league");
  await L.set({ name: "U", season_id: REG, isTestNode: true });
  await L.collection("teams").doc("t1").set({ players: ["p9", "p1"] });
  // A box score of this season has "p7", on no roster.
  await db.collection("game_box_scores").doc("g1").set({ gameId: "g1", seasonId: REG, date: "2030-12-05", skaters: { p7: { name: "Hope Seven", team: "visitor", goals: 1 } }, goalies: {} });
  await sync();
  const ada = await P("p1");
  check(ada && ada.current_team_id === null && ada.universe.source === "retained", "a player dropped from every feed is kept, with no PWHL team (retained)");
  const gia = await P("p9");
  check(gia && gia.first_name === "Gia" && gia.position === "D" && gia.current_team_id === null && gia.universe.source === "fantasy_roster", "a fantasy-rostered player with no season doc gets one from her older doc (FA)");
  check(gia && !("points" in gia) && !("gp" in gia), "no stats are copied from another season");
  const hope = await P("p7");
  check(hope && hope.name === "Hope Seven" && hope.current_team_id === "2" && hope.universe.source === "game", "a player seen only in a box score is added with her game's team");

  console.log("\nSECOND RUN");
  const snapshot = async () => (await db.collection("pwhl_players").where("season_id", "==", REG).get()).docs
    .map(d => `${d.id}:${d.data().current_team_id}:${d.data().universe.source}`).sort().join("|");
  const before = await snapshot();
  await sync();
  check(before === (await snapshot()), "running the sync again changes no team or source");
  check((await db.collection("pwhl_players").where("season_id", "==", REG).get()).size === 7, "no player doc is ever deleted (7 players)");
} catch (err) {
  console.error("❌ unexpected error:", err.stack || err);
  failures++;
} finally {
  for (const c of ["pwhl_players", "pwhl_teams", "pwhl_games", "pwhl_player_stats", "game_box_scores", "pwhl_game_summaries"]) await db.recursiveDelete(db.collection(c));
  for (const id of [REG, PRE]) await db.collection("pwhl_seasons").doc(id).delete();
  await db.recursiveDelete(db.collection("fantasy_leagues").doc("test_universe_league"));
}
console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
