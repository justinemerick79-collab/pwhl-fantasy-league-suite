/**
 * test-draft-rankings.js
 *
 * Draft value (functions/draftRanking.js, src/services/scoring.js): bots and auto-picks
 * rank by projected fantasy points under the LEAGUE's scoring — projection first, then
 * the previous regular season, then nothing. Before, both read a `stats` field real
 * player docs lack, so every player scored 0 (bots drafted alphabetically).
 *
 * Part 1: server and browser formulas agree. Part 2: the real bot engine (Functions
 * emulator trigger) picks by projections, honours league scoring, and falls back to
 * last season. Emulator only; removes what it wrote.
 *
 *   firebase emulators:exec --only functions,firestore,auth "npx tsx test-draft-rankings.js"
 */
import { createRequire } from "module";
import { requireEmulator } from "./test-support.js";

requireEmulator("test-draft-rankings.js");
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || "pwhl-fantasy-mobile-26";
const require = createRequire(import.meta.url);
const server = require("./functions/draftRanking.js");
const client = await import("./src/services/scoring.js");
const fnRequire = createRequire(new URL("./functions/index.js", import.meta.url));
const { initializeApp } = fnRequire("firebase-admin/app");
const { getFirestore, Timestamp } = fnRequire("firebase-admin/firestore");
const db = getFirestore(initializeApp({ projectId: "pwhl-fantasy-mobile-26" }, "test-draft-rankings"));

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "✅" : "❌"} ${label}`); if (!ok) failures++; };

function part1() {
  console.log("\nPART 1 — server and browser formulas agree");
  const scoring = { skaters: { goals: 3, assists: 2, plusMinus: 1, ppp: 1, shp: 2, sog: 0.25, hits: 0.3, blocks: 0.4, defensePoints: 1 }, goalies: { wins: 5, otl: 2, ga: -1.5, saves: 0.3, shutouts: 4 } };
  let worst = 0;
  for (let i = 0; i < 300; i++) {
    const r = () => Math.round(Math.random() * 400) / 10;
    const proj = { goals: r(), assists: r(), plusMinus: r() - 20, powerPlayPoints: r(), shortHandedPoints: r(), shotsOnGoal: r(), hits: r(), blockedShots: r(), wins: r(), overtimeLosses: r(), goalsAgainst: r(), shotsSaved: r() * 10, shutouts: r() };
    const row = { goals: r(), assists: r(), plus_minus: r(), power_play_points: r(), short_handed_points: r(), shots: r(), hits: r(), shots_blocked_by_player: r(), wins: r(), ot_losses: r(), goals_against: r(), saves: r() * 10, shutouts: r() };
    for (const pos of ["F", "D", "G"]) {
      worst = Math.max(worst,
        Math.abs(server.projectedPoints(server.fromProjection(proj), scoring, pos) - client.projectedPoints(client.rankLineFromProjection(proj), scoring, pos)),
        Math.abs(server.projectedPoints(server.fromSeasonStats(row), scoring, pos) - client.projectedPoints(client.rankLineFromSeasonStats(row), scoring, pos)));
    }
  }
  check(worst < 1e-9, `identical values on 1,800 random cases (worst gap ${worst})`);
}

const S = "9921", PREV = "9920", BOT = "test_rank_bot";
const created = [];
async function setup() {
  for (const [id, start] of [[S, "2031-12-01"], [PREV, "2030-12-01"]]) {
    const ref = db.collection("pwhl_seasons").doc(id);
    await ref.set({ season_id: id, career: "1", playoff: "0", start_date: start, isTestNode: true }); created.push(ref);
  }
  const players = [
    { id: "rk_sniper", pos: "F", proj: { goals: 30, assists: 10, shotsOnGoal: 120, hits: 5 } },   // default scoring: highest
    { id: "rk_hitter", pos: "F", proj: { goals: 4, assists: 4, shotsOnGoal: 40, hits: 220 } },    // wins only if hits are worth a lot
    { id: "rk_vet", pos: "D", last: { goals: 5, assists: 10, shots: 40, hits: 10, shots_blocked_by_player: 20 } }, // no projection: last season (≈42.5 pts < sniper 82.5)
    { id: "rk_rookie", pos: "F" },                                                                  // nothing yet
  ];
  for (const p of players) {
    const ref = db.collection("pwhl_players").doc(`${S}_${p.id}`);
    await ref.set({ player_id: p.id, season_id: S, position: p.pos, first_name: p.id, isTestNode: true }); created.push(ref);
    if (p.proj) { const pr = db.collection("pwhl_projections").doc(S).collection("player_projections").doc(p.id); await pr.set({ playerId: p.id, projected_season_stats: p.proj }); created.push(pr); }
    if (p.last) { const st = db.collection("pwhl_player_stats").doc(`${PREV}_${p.id}`); await st.set({ player_id: p.id, season_id: PREV, ...p.last }); created.push(st); }
  }
  const bot = db.collection("users").doc(BOT);
  await bot.set({ isBot: true, role: "user", isTestNode: true }); created.push(bot);
}

/** One bot pick from the given pool. Returns the picked player id. */
async function botPick(leagueId, { scoring, pool }) {
  const L = db.collection("fantasy_leagues").doc(leagueId);
  await L.set({ name: leagueId, status: "drafting", members: [BOT], season_id: S, scoringSettings: scoring,
    rosterSettings: { forwards: { starters: 1, max: 5 }, defense: { starters: 0, max: 5 }, goalies: { starters: 0, max: 5 }, bench: 6 }, isTestNode: true });
  await L.collection("teams").doc("t_bot").set({ ownerId: BOT, teamName: "Bot", players: [], isBot: true });
  const taken = ["rk_sniper", "rk_hitter", "rk_vet", "rk_rookie"].filter(id => !pool.includes(id));
  await L.collection("draft").doc("state").set({
    status: "active", draftOrder: [BOT], currentRound: 1, currentPickIndex: taken.length, currentTeamOnClock: BOT,
    pickDeadline: Timestamp.fromMillis(Date.now() + 60000),
    picks: taken.map((pid, i) => ({ playerId: pid, pickIndex: i, ownerId: "someone_else" })),
    activeRosters: { [BOT]: [] }, isTestNode: true,
  });
  created.push(L);
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    const picks = (await L.collection("draft").doc("state").get()).data()?.picks || [];
    if (picks.length > taken.length) return picks[picks.length - 1].playerId;
  }
  return null;
}

async function part2() {
  console.log("\nPART 2 — the real bot engine");
  await setup();
  const all = ["rk_sniper", "rk_hitter", "rk_vet", "rk_rookie"];
  check((await botPick("rk_default", { scoring: null, pool: all })) === "rk_sniper", "default scoring: the bot takes the top projected scorer (not alphabetical)");
  const hitsHeavy = { skaters: { goals: 1, assists: 1, sog: 0, hits: 1, blocks: 0 } };
  check((await botPick("rk_hits", { scoring: hitsHeavy, pool: all })) === "rk_hitter", "the league's scoring decides: with hits worth 1 point, the hitter goes first");
  check((await botPick("rk_lastseason", { scoring: null, pool: ["rk_vet", "rk_rookie"] })) === "rk_vet", "no projection: last regular season's stats rank the veteran above a player with no data");
}

try {
  part1();
  await part2();
} catch (err) {
  console.error("❌ unexpected error:", err.stack || err);
  failures++;
} finally {
  for (const ref of created.reverse()) { try { await db.recursiveDelete(ref); } catch { await ref.delete().catch(() => {}); } }
}
console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
