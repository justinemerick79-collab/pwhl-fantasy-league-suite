/**
 * test-live-scoring.js
 *
 * Live scoring, post-game checks, the nightly official switch, and the settlement
 * gate (functions/liveStats.js). Replays a real LeagueStat game summary
 * (test-fixtures/gamesummary-358-final.json) through a stubbed fetch, edited to act
 * out each stage of a game. Writes only to the emulator and removes what it wrote.
 *
 *   firebase emulators:exec --only functions,firestore,auth "npx tsx test-live-scoring.js"
 */
import fs from "node:fs";
import { createRequire } from "module";
import { requireEmulator } from "./test-support.js";

requireEmulator("test-live-scoring.js");
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || "pwhl-fantasy-mobile-26";

const require = createRequire(import.meta.url);
const live = require("./functions/liveStats.js");
const { pacificDateStr, addDays } = require("./functions/dates.js");
const fnRequire = createRequire(new URL("./functions/index.js", import.meta.url));
const { initializeApp } = fnRequire("firebase-admin/app");
const { getFirestore, Timestamp } = fnRequire("firebase-admin/firestore");
const db = getFirestore(initializeApp({ projectId: "pwhl-fantasy-mobile-26" }, "test-live-scoring"));

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "✅" : "❌"} ${label}`); if (!ok) failures++; };
const MIN = 60000;
const FINAL = JSON.parse(fs.readFileSync(new URL("./test-fixtures/gamesummary-358-final.json", import.meta.url))).GC.Gamesummary;

/** LeagueStat-style "YYYY-MM-DD HH:MM:SS" in Eastern (UTC-5) for a ms time. */
const etStamp = (ms) => new Date(ms - 5 * 3600000).toISOString().replace("T", " ").slice(0, 19);

/** A copy of game 358 as a given game/date/stage. */
function summary({ date, status = "4", final = "1", modifiedAt, edit }) {
  const s = structuredClone(FINAL);
  s.meta = { ...s.meta, date_played: date, status, final, last_modified: etStamp(modifiedAt) };
  if (edit) edit(s);
  return s;
}
const firstSkater = (s) => s.home_team_lineup.players[0];
// The skater with the most shots in the real game (a correction of −2 stays ≥ 0).
const topShooterIndex = FINAL.home_team_lineup.players.reduce((best, p, i, a) => (+(p.shots_on || p.shots) > +(a[best].shots_on || a[best].shots) ? i : best), 0);
const topShooter = (s) => s.home_team_lineup.players[topShooterIndex];

// The stub feed: tests set feed[gameId] = summary (or a function of call count).
const feed = {};
const calls = [];
const fetchSummary = async (id) => { calls.push(String(id)); const v = feed[String(id)]; return typeof v === "function" ? v() : v || null; };
const deps = { fetchSummary };
const created = [];
const box = async (id) => (await db.collection("game_box_scores").doc(id).get()).data();
const day = async (d) => (await db.collection("daily_game_stats").doc(d).get()).data();

async function partGate() {
  console.log("\nGAME-DAY GATE");
  const NOW = Date.parse("2026-12-09T12:00:00-08:00"); // a Wednesday with no seeded games
  await live.planGameDay(db, NOW);
  calls.length = 0;
  const r = await live.runLivePoll(db, NOW, deps);
  check(r.startsWith("idle: no games") && calls.length === 0, `no games today → idle, no feed calls (${r})`);
  check(live.modifiedMs("2026-11-25 20:53:52") === Date.parse("2026-11-26T01:53:52Z"), "last_modified is read as Eastern time");
  check(pacificDateStr(Date.parse("2026-11-30T01:30:00Z")) === "2026-11-29", "a game at 8:30 pm ET Sunday is on Sunday's Pacific date");
}

async function partLiveDay() {
  console.log("\nLIVE GAME → FINAL → POST-GAME CHECKS → OFFICIAL");
  const START = Date.parse("2026-12-10T16:00:00-08:00");
  const date = pacificDateStr(START);
  const gid = "test_live_1";
  await db.collection("pwhl_games").doc(gid).set({ game_id: gid, date_played: date, GameDateISO8601: new Date(START).toISOString(), status: "1", home_team_code: "MTL", visiting_team_code: "BOS" });
  created.push(db.collection("pwhl_games").doc(gid), db.collection("game_box_scores").doc(gid), db.collection("pwhl_game_summaries").doc(gid), db.collection("daily_game_stats").doc(date));
  const league = db.collection("fantasy_leagues").doc("test_live_league");
  await league.set({ name: "Live", status: "active", isTestNode: true, scoringSettings: { skaters: { goals: 10, assists: 5, sog: 1 }, goalies: { saves: 1 } } });
  created.push(league);

  let t = START - 3 * 3600000;
  await live.planGameDay(db, t);
  calls.length = 0;
  check((await live.runLivePoll(db, t, deps)).includes("before first game"), "3 h before puck drop → no feed calls");

  // In progress: the first skater has 1 shot so far.
  t = START + 20 * MIN;
  feed[gid] = summary({ date, status: "2", final: "0", modifiedAt: t, edit: s => { Object.assign(firstSkater(s), { goals: "0", shots: "1", shots_on: "1", hits: "0" }); s.goals = []; } });
  await live.runLivePoll(db, t, deps);
  let b = await box(gid);
  check(b?.status === "live" && b.skaters[firstSkater(FINAL).player_id].sog === 1, `live box score stored (status ${b?.status})`);
  let d = await day(date);
  check(d?.status === "live" && d.leaguePoints?.test_live_league, `day points exist DURING the game (day status ${d?.status})`);
  const changedAt1 = b.changedAt.toMillis();

  t += 5 * MIN;
  await live.runLivePoll(db, t, deps);
  b = await box(gid);
  check(b.changedAt.toMillis() === changedAt1, "same data on the next poll → no new write");

  // Final: the full real box score.
  t = START + 150 * MIN;
  const finalAt = t;
  feed[gid] = summary({ date, status: "4", final: "1", modifiedAt: t });
  await live.runLivePoll(db, t, deps);
  b = await box(gid);
  check(b.status === "final" && b.finalAt, `status 4 → final (status ${b.status})`);
  const corrections0 = (await db.collection("stat_corrections").where("gameId", "==", gid).get()).size;
  check(corrections0 === 0, "live → final changes are not corrections");

  // +5 min: no post-game check due yet.
  calls.length = 0;
  await live.runLivePoll(db, finalAt + 5 * MIN, deps);
  check(calls.length === 0, "no post-game check before +15 min");

  // +15 min: LeagueStat corrects the first skater's shots (−2).
  const pid = String(topShooter(FINAL).player_id);
  const sogFinal = parseInt(topShooter(FINAL).shots_on || topShooter(FINAL).shots, 10);
  feed[gid] = summary({ date, modifiedAt: finalAt + 14 * MIN, edit: s => { topShooter(s).shots_on = String(sogFinal - 2); topShooter(s).shots = String(sogFinal - 2); } });
  calls.length = 0;
  await live.runLivePoll(db, finalAt + 15 * MIN, deps);
  check(calls.length === 1, "post-game check at +15 min fetches the game");
  const corr = (await db.collection("stat_corrections").where("gameId", "==", gid).get()).docs.map(x => x.data());
  check(corr.length === 1 && corr[0].playerId === pid && corr[0].changes.some(c => c.stat === "sog" && c.from === sogFinal && c.to === sogFinal - 2),
    `correction logged: ${corr[0]?.playerName} SOG ${sogFinal}→${sogFinal - 2}`);
  b = await box(gid);
  check(b.status === "final", "a just-changed game is not official yet");

  // +30 and +60 min: unchanged → stable → official.
  await live.runLivePoll(db, finalAt + 30 * MIN, deps);
  await live.runLivePoll(db, finalAt + 60 * MIN, deps);
  b = await box(gid);
  check(b.status === "official" && b.officialAt, `unchanged for 30+ min → official (status ${b.status})`);
  d = await day(date);
  check(d.status === "official", `day status official (${d.status})`);
  check((await db.collection("pwhl_game_summaries").doc(gid).get()).exists, "raw summary saved once official");
  const state = (await db.collection("live_state").doc("current").get()).data();
  check(state.allStable === true, "every game official → poller goes idle");
  calls.length = 0;
  await live.runLivePoll(db, finalAt + 125 * MIN, deps);
  check(calls.length === 0, "idle poller makes no feed calls");
  // clean the correction docs
  for (const x of (await db.collection("stat_corrections").where("gameId", "==", gid).get()).docs) created.push(x.ref);
}

async function partTwoGamesOneDay() {
  console.log("\nTWO GAMES ON ONE DAY");
  const date = "2026-12-12";
  const s = summary({ date, modifiedAt: Date.parse("2026-12-01T00:00:00Z") });
  for (const id of ["test_dbl_a", "test_dbl_b"]) {
    feed[id] = s;
    await live.refreshGame(db, id, Date.parse("2026-12-13T12:00:00Z"), deps);
    created.push(db.collection("game_box_scores").doc(id), db.collection("pwhl_games").doc(id), db.collection("pwhl_game_summaries").doc(id));
  }
  created.push(db.collection("daily_game_stats").doc(date));
  await live.snapshotLiveDay(db, date);
  const pid = String(firstSkater(FINAL).player_id);
  const one = (await box("test_dbl_a")).skaters[pid].sog;
  const d = await day(date);
  check(d.playerPoints[pid].stats.sog === one * 2, `a player's stats add up across two games (SOG ${one} + ${one} = ${d.playerPoints[pid].stats.sog})`);
}

async function partReconcile() {
  console.log("\nNIGHTLY OFFICIAL SWITCH");
  const NOW = Date.parse("2026-12-15T01:00:00-08:00");
  const y = addDays(pacificDateStr(NOW), -1);
  const gid = "test_recon_1";
  await db.collection("pwhl_games").doc(gid).set({ game_id: gid, date_played: y, status: "4" });
  created.push(db.collection("pwhl_games").doc(gid), db.collection("game_box_scores").doc(gid), db.collection("pwhl_game_summaries").doc(gid), db.collection("daily_game_stats").doc(y));
  // Last modified 14 h ago → stable at once.
  feed[gid] = summary({ date: y, modifiedAt: NOW - 14 * 3600000 });
  await live.reconcileRecentGames(db, NOW, deps);
  check((await box(gid)).status === "official", "a final game untouched for 12+ h becomes official in one run");
  check((await day(y)).status === "official", "yesterday's points rebuilt as official");
  // A late correction the next night.
  const pid = String(firstSkater(FINAL).player_id);
  feed[gid] = summary({ date: y, modifiedAt: NOW + 20 * 3600000, edit: s => { firstSkater(s).hits = String(parseInt(firstSkater(FINAL).hits || 0, 10) + 1); } });
  await live.reconcileRecentGames(db, NOW + 24 * 3600000, deps);
  const corr = (await db.collection("stat_corrections").where("gameId", "==", gid).get()).docs.map(x => x.data());
  check(corr.length === 1 && corr[0].afterOfficial === true && corr[0].playerId === pid, "a change after official is logged (afterOfficial)");
  check((await box(gid)).status === "final", "and the game waits to be confirmed again");
  for (const x of (await db.collection("stat_corrections").where("gameId", "==", gid).get()).docs) created.push(x.ref);
}

async function partSettlementGate() {
  console.log("\nSETTLEMENT WAITS FOR OFFICIAL DATA (real hourly job)");
  live.setFetchSummaryForTests(fetchSummary);
  const fns = require("./functions/index.js");
  const now = Date.now();
  const season = db.collection("pwhl_seasons").doc("test_gate_season");
  const weekEnd = now - 2 * 3600000; // ended 2 h ago
  await season.set({ isTestNode: true, weeks: [
    { week: 1, start: new Date(weekEnd - 7 * 86400000 + 1).toISOString(), end: new Date(weekEnd).toISOString(), isOffWeek: false, gameCount: 1, games: ["test_gate_g1"] },
    { week: 2, start: new Date(weekEnd + 1).toISOString(), end: new Date(weekEnd + 7 * 86400000).toISOString(), isOffWeek: false, gameCount: 0, games: [] },
  ] });
  const L = db.collection("fantasy_leagues").doc("test_gate_league");
  await L.set({ name: "Gate", status: "active", season_id: "test_gate_season", currentWeek: 1, isTestNode: true, scoringSettings: {} });
  created.push(season, L, db.collection("game_box_scores").doc("test_gate_g1"), db.collection("pwhl_games").doc("test_gate_g1"), db.collection("pwhl_game_summaries").doc("test_gate_g1"));
  // The game's data changed 5 min ago: final, but not yet stable.
  feed.test_gate_g1 = summary({ date: "2026-11-01", modifiedAt: now - 5 * 60000 });
  created.push(db.collection("daily_game_stats").doc("2026-11-01"));

  await fns.settleMatchupWeeksScheduled.run({});
  check((await L.get()).data().currentWeek === 1, "a week with a game not yet official is NOT settled");
  // 40 min later the data is unchanged → official → settles. (Shift the stored unchangedSince back.)
  await db.collection("game_box_scores").doc("test_gate_g1").update({ unchangedSince: Timestamp.fromMillis(now - 40 * 60000) });
  await fns.settleMatchupWeeksScheduled.run({});
  check((await box("test_gate_g1")).status === "official", "the gate re-checks the game and confirms it");
  check((await L.get()).data().currentWeek === 2, "then the week settles (currentWeek 1 → 2)");
  await fns.settleMatchupWeeksScheduled.run({});
  check((await L.get()).data().currentWeek === 2, "a second run does not settle it again");

  // Safety valve: a week that ended 25 h ago with a game LeagueStat never confirms.
  const V = db.collection("fantasy_leagues").doc("test_valve_league");
  const vs = db.collection("pwhl_seasons").doc("test_valve_season");
  const vEnd = now - 25 * 3600000;
  await vs.set({ isTestNode: true, weeks: [{ week: 1, start: new Date(vEnd - 7 * 86400000).toISOString(), end: new Date(vEnd).toISOString(), isOffWeek: false, gameCount: 1, games: ["test_valve_g1"] }] });
  await V.set({ name: "Valve", status: "active", season_id: "test_valve_season", currentWeek: 1, isTestNode: true, scoringSettings: {} });
  feed.test_valve_g1 = () => summary({ date: "2026-11-02", modifiedAt: Date.now() }); // keeps changing
  created.push(V, vs, db.collection("game_box_scores").doc("test_valve_g1"), db.collection("pwhl_games").doc("test_valve_g1"), db.collection("daily_game_stats").doc("2026-11-02"),
    db.collection("stat_corrections").doc("unconfirmed_test_valve_season_1"));
  await fns.settleMatchupWeeksScheduled.run({});
  check((await V.get()).data().currentWeek === 2, "safety valve: settles 24 h+ after week end");
  check((await db.collection("stat_corrections").doc("unconfirmed_test_valve_season_1").get()).exists, "and posts an 'unconfirmed data' notice to the feed");
  live.setFetchSummaryForTests(null);
}

try {
  await partGate();
  await partLiveDay();
  await partTwoGamesOneDay();
  await partReconcile();
  await partSettlementGate();
} finally {
  for (const ref of created) { try { await db.recursiveDelete(ref); } catch { await ref.delete().catch(() => {}); } }
  await db.collection("live_state").doc("current").delete().catch(() => {});
}
console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
