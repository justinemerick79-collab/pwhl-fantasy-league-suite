/**
 * test-beta-rehearsal.js — one private league, start to finish, through the app's real code.
 *
 *   sync (player universe) → create league → 3 managers join → draft → schedule
 *   → lineup → live game day → official switch → waiver claim → trade
 *   → weekly settlement → playoffs → champion
 *
 * User actions run through the app's client services (src/services/leagueService.js)
 * as real signed-in users against the Firestore rules; Cloud Function triggers run in
 * the Functions emulator; scheduled jobs run in-process with a stubbed PWHL feed.
 *
 * Time: a test season set in the past (so weekly settlement can act on ended weeks),
 * with the global simulation clock placed before it so the draft happens "pre-season".
 *
 *   firebase emulators:exec --only functions,firestore,auth "npx tsx test-beta-rehearsal.js"
 */
import { createRequire } from "module";
import { connectAuthEmulator, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from "firebase/auth";
import { connectFirestoreEmulator, doc as cDoc, getDoc as cGetDoc } from "firebase/firestore";
import { requireEmulator, emulatorHosts } from "./test-support.js";

requireEmulator("test-beta-rehearsal.js");
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || "pwhl-fantasy-mobile-26";
const hosts = emulatorHosts();
const { db: clientDb, auth } = await import("./src/firebase.js");
connectFirestoreEmulator(clientDb, hosts.firestore.host, hosts.firestore.port);
connectAuthEmulator(auth, hosts.authUrl);
const svc = await import("./src/services/leagueService.js");

const require = createRequire(import.meta.url);
const { runSync } = require("./functions/dataSync.js");
const live = require("./functions/liveStats.js");
const fnRequire = createRequire(new URL("./functions/index.js", import.meta.url));
const { initializeApp } = fnRequire("firebase-admin/app");
const { getFirestore } = fnRequire("firebase-admin/firestore");
const { getAuth: adminAuth } = fnRequire("firebase-admin/auth");
const adminApp = initializeApp({ projectId: "pwhl-fantasy-mobile-26" }, "test-beta-rehearsal");
const db = getFirestore(adminApp);

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "✅" : "❌"} ${label}`); if (!ok) failures++; };
const waitFor = async (fn, ms = 40000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 500)); } return null; };

// ── The test season ──────────────────────────────────────────────────────────
const REG = "9911", PRE = "9910";
const MONDAYS = ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05"]; // 5 game weeks, all ended
const GAMES = MONDAYS.map((m, i) => {
  const wed = new Date(`${m}T12:00:00Z`); wed.setUTCDate(wed.getUTCDate() + 2);
  const date = wed.toISOString().slice(0, 10);
  return { game_id: `9911${i + 1}`, season_id: REG, date_played: date, GameDateISO8601: `${date}T19:00:00-04:00`, status: "1", home_team: "1", visiting_team: "2", home_team_code: "BOS", visiting_team_code: "MTL" };
});
// 80 preseason players on two PWHL teams: 48 F, 20 D, 12 G.
const PLAYERS = [];
for (let i = 1; i <= 80; i++) {
  const pos = i <= 48 ? "F" : i <= 68 ? "D" : "G";
  PLAYERS.push({ id: `${7000 + i}`, player_id: `${7000 + i}`, first_name: `P${i}`, last_name: pos, position: pos, status: "Signed", _team: i % 2 ? "1" : "2" });
}
const feed = {
  seasons: [
    { season_id: REG, season_name: "Rehearsal Regular", career: "1", playoff: "0", start_date: "2026-09-07", end_date: "2026-10-11" },
    { season_id: PRE, season_name: "Rehearsal Preseason", career: "0", playoff: "0", start_date: "2026-08-01", end_date: "2026-09-01" },
  ],
  teams: [{ id: "1", name: "Boston", code: "BOS" }, { id: "2", name: "Montréal", code: "MTL" }],
};
const api = async (q) => {
  if (q.view === "seasons") return { SiteKit: { Seasons: feed.seasons } };
  if (q.view === "teamsbyseason") return { SiteKit: { Teamsbyseason: feed.teams } };
  if (q.view === "roster") return { SiteKit: { Roster: q.season_id === PRE ? PLAYERS.filter(p => p._team === q.team_id) : [] } };
  if (q.view === "schedule") return { SiteKit: { Schedule: q.season_id === REG ? GAMES : [] } };
  if (q.view === "statviewtype") return { SiteKit: { Statviewtype: [] } };
  return null;
};

// A LeagueStat-shaped game summary. Every skater shoots; higher ids score more.
const etStamp = (ms) => new Date(ms - 5 * 3600000).toISOString().replace("T", " ").slice(0, 19);
function summary(game, { status = "4", modifiedAt, scale = 1 }) {
  const line = (p) => {
    const n = parseInt(p.id, 10) % 7;
    return { player_id: p.id, first_name: p.first_name, last_name: p.last_name, position_str: p.position,
      goals: String(Math.floor((n * scale) / 3)), shots: String(n * scale), shots_on: String(n * scale), hits: String(n % 3), plusminus: "0", pim: "0", shots_blocked_by_player: "1" };
  };
  const side = (team) => PLAYERS.filter(p => p._team === team);
  const goalies = (team) => side(team).filter(p => p.position === "G").slice(0, 1).map(p => ({ player_id: p.id, first_name: p.first_name, last_name: p.last_name, saves: String(25 * scale), goals_against: "2", shots_against: String(27 * scale), secs: "3600", win: team === "1" ? "1" : "0", loss: team === "1" ? "0" : "1" }));
  return {
    meta: { id: game.game_id, season_id: REG, date_played: game.date_played, status, final: status === "4" ? "1" : "0", last_modified: etStamp(modifiedAt) },
    home_team_lineup: { players: side("1").filter(p => p.position !== "G").map(line) },
    visitor_team_lineup: { players: side("2").filter(p => p.position !== "G").map(line) },
    goalies: { home: goalies("1"), visitor: goalies("2") }, goals: [], totalGoals: { home: 3, visitor: 2 },
  };
}
const stubFeed = {};
const fetchSummary = async (id) => stubFeed[String(id)] || null;

// ── Users ─────────────────────────────────────────────────────────────────
const PW = "Rehearsal123!";
const USERS = ["commish", "mgr2", "mgr3", "mgr4", "late5"].map(n => ({ name: n, email: `rehearsal_${n}@example.com` }));
async function signInAs(u) {
  await signOut(auth).catch(() => {});
  try { u.uid = (await createUserWithEmailAndPassword(auth, u.email, PW)).user.uid; }
  catch { u.uid = (await signInWithEmailAndPassword(auth, u.email, PW)).user.uid; }
  return u.uid;
}

const L = { id: null };
const leagueDoc = async () => (await db.collection("fantasy_leagues").doc(L.id).get()).data();
const teams = async () => (await db.collection("fantasy_leagues").doc(L.id).collection("teams").get()).docs.map(d => ({ id: d.id, ...d.data() }));

try {
  console.log("\n1. SEASON SETUP (admin sync builds the player universe)");
  await db.collection("app_settings").doc("active_season").set({ active_season_id: REG, active_season_name: "Rehearsal Regular" });
  await db.collection("admin_settings").doc("simulation_state").set({ testModeActive: true, current_simulated_date: "2026-09-01" });
  await runSync(db, { target: REG, api, sleepMs: 0, maxSummaries: 0, log: () => {} });
  const season = (await db.collection("pwhl_seasons").doc(REG).get()).data();
  check(season.universe?.total === 80 && season.weeks?.length === 5, `universe ${season.universe?.total} players, ${season.weeks?.length} game weeks`);

  console.log("\n2. CREATE AND JOIN");
  for (const u of USERS) { await signInAs(u); await db.collection("users").doc(u.uid).set({ email: u.email, role: "user" }); }
  await signInAs(USERS[0]);
  const created = await svc.createLeague("Rehearsal League", 4, USERS[0].uid, "Commish Crew", REG);
  L.id = created.leagueId;
  let lg = await leagueDoc();
  check(lg.season_id === REG, `new league stores its season (${lg.season_id})`);
  check(JSON.stringify(lg.waiverOrder) === JSON.stringify([created.teamId]), "waiver order starts with the commissioner's TEAM id");
  for (const u of USERS.slice(1, 4)) { await signInAs(u); await svc.joinLeague(created.inviteCode, u.uid, `${u.name} Team`); }
  lg = await leagueDoc();
  check(lg.members.length === 4 && lg.waiverOrder.length === 4, `3 managers join by invite code (${lg.members.length} members, waiver order ${lg.waiverOrder.length} teams)`);
  await signInAs(USERS[4]);
  let fullErr = null; try { await svc.joinLeague(created.inviteCode, USERS[4].uid, "Late"); } catch (e) { fullErr = e.message; }
  check(/full/i.test(fullErr || ""), `a 5th manager is refused ("${fullErr}")`);

  console.log("\n3. DRAFT (snake, 15 rounds, 4 teams)");
  await signInAs(USERS[0]);
  const order = USERS.slice(0, 4).map(u => u.uid);
  await svc.initializeDraft(L.id, order);
  const plan = ["G", "D", "D", "D", "D", "F", "F", "F", "F", "F", "F", "F", "F", "D", "G"];
  const taken = new Set();
  const picksBy = Object.fromEntries(order.map(u => [u, 0]));
  for (let pick = 0; pick < 60; pick++) {
    const st = (await cGetDoc(cDoc(clientDb, `fantasy_leagues/${L.id}/draft`, "state"))).data();
    const uid = st.currentTeamOnClock;
    const want = plan[picksBy[uid]++];
    const p = PLAYERS.find(x => x.position === want && !taken.has(x.id));
    taken.add(p.id);
    await svc.submitDraftPick(L.id, uid, p.id);
  }
  lg = await leagueDoc();
  const ts = await teams();
  check(lg.status === "active" && ts.every(t => (t.players || []).length === 15), `draft completes; league active; every team has 15 players`);
  const posOf = (id) => PLAYERS.find(p => p.id === id)?.position;
  check(ts.every(t => t.players.filter(id => posOf(id) === "G").length === 2), "each team has its 2 goalies (positions read from the season universe)");

  console.log("\n4. SCHEDULE (trigger on draft completion)");
  const matchups = await waitFor(async () => { const s = await db.collection("fantasy_leagues").doc(L.id).collection("matchups").get(); return s.size >= 6 ? s : null; });
  lg = await leagueDoc();
  check(matchups && matchups.size === 6, `regular season: 6 matchups (3 weeks × 2) — got ${matchups?.size}`);
  check(JSON.stringify(lg.schedule?.playoffWeeks) === JSON.stringify([4, 5]), `last 2 weeks reserved for the 4-team playoff (${JSON.stringify(lg.schedule?.playoffWeeks)})`);

  console.log("\n5. LINEUP");
  await signInAs(USERS[0]);
  const mine = ts.find(t => t.ownerId === USERS[0].uid);
  const byPos = (pos) => mine.players.filter(id => posOf(id) === pos);
  const lineup = {};
  byPos("F").slice(0, 6).forEach((id, i) => { lineup[`F${i + 1}`] = id; });
  byPos("D").slice(0, 4).forEach((id, i) => { lineup[`D${i + 1}`] = id; });
  lineup.G1 = byPos("G")[0];
  const bench = mine.players.filter(id => !Object.values(lineup).includes(id));
  await svc.saveDailyLineup(L.id, mine.id, GAMES[0].date_played, lineup, bench);
  check((await db.doc(`fantasy_leagues/${L.id}/teams/${mine.id}/daily_lineups/${GAMES[0].date_played}`).get()).exists, "the commissioner saves a lineup for game day 1");

  console.log("\n6. LIVE GAME DAY → OFFICIAL");
  const g1 = GAMES[0];
  const start = Date.parse(g1.GameDateISO8601);
  stubFeed[g1.game_id] = summary(g1, { status: "2", modifiedAt: start + 20 * 60000, scale: 0.5 });
  await live.planGameDay(db, start - 3600000);
  await live.runLivePoll(db, start + 20 * 60000, { fetchSummary });
  let day = (await db.collection("daily_game_stats").doc(g1.date_played).get()).data();
  check(day?.status === "live" && day.leaguePoints?.[L.id], `points for this league exist during the game (day status ${day?.status})`);
  for (const g of GAMES) stubFeed[g.game_id] = summary(g, { modifiedAt: Date.parse(g.GameDateISO8601) + 3 * 3600000 });
  for (const g of GAMES) await live.reconcileRecentGames(db, Date.parse(`${g.date_played}T12:00:00-07:00`) + 86400000, { fetchSummary });
  const boxes = await Promise.all(GAMES.map(g => db.collection("game_box_scores").doc(g.game_id).get()));
  check(boxes.every(b => b.data()?.status === "official"), "the nightly switch marks every game official");

  console.log("\n7. WAIVER CLAIM");
  const ts2 = await teams();
  const t1 = ts2.find(t => t.ownerId === USERS[0].uid), t2 = ts2.find(t => t.ownerId === USERS[1].uid);
  const freeAgent = PLAYERS.find(p => p.position === "F" && !taken.has(p.id));
  const dropped = t1.players.find(id => posOf(id) === "F" && !Object.values(lineup).includes(id));
  await signInAs(USERS[0]);
  await svc.submitAddDrop(L.id, t1.id, USERS[0].uid, freeAgent.id, dropped);
  check((await db.doc(`fantasy_leagues/${L.id}/waivers/${dropped}`).get()).exists, "commissioner adds a free agent; the dropped player goes on waivers");
  await signInAs(USERS[1]);
  const t2drop = t2.players.find(id => posOf(id) === "F");
  await svc.submitWaiverClaim(L.id, t2.id, USERS[1].uid, dropped, t2drop);
  const orderBefore = (await leagueDoc()).waiverOrder;
  const { processLeagueTransactions } = require("./functions/transactions.js");
  await processLeagueTransactions(db, L.id, Date.parse("2026-09-04T12:00:00Z"));
  const t2after = (await db.doc(`fantasy_leagues/${L.id}/teams/${t2.id}`).get()).data();
  const orderAfter = (await leagueDoc()).waiverOrder;
  check(t2after.players.includes(dropped) && !t2after.players.includes(t2drop), "manager 2's waiver claim is awarded after 48 h");
  check(orderAfter[orderAfter.length - 1] === t2.id && orderBefore.includes(t2.id), "the winning team moves to the end of the waiver order");

  console.log("\n8. TRADE (no review window → immediate)");
  await db.collection("fantasy_leagues").doc(L.id).set({ tradeSettings: { tradeReviewHours: 0, enableVetoes: false, vetoThreshold: 3 } }, { merge: true });
  const ts3 = await teams();
  const a = ts3.find(t => t.ownerId === USERS[0].uid), c = ts3.find(t => t.ownerId === USERS[2].uid);
  const sendA = a.players.find(id => posOf(id) === "D"), sendC = c.players.find(id => posOf(id) === "D");
  await signInAs(USERS[0]);
  const tradeId = await svc.submitTradeProposal(L.id, a.id, c.id, [sendA], [sendC]);
  await signInAs(USERS[2]);
  await svc.respondToTrade(L.id, tradeId, USERS[2].uid, "accept");
  const processed = await waitFor(async () => (await db.doc(`fantasy_leagues/${L.id}/trades/${tradeId}`).get()).data()?.status === "processed");
  const aAfter = (await db.doc(`fantasy_leagues/${L.id}/teams/${a.id}`).get()).data();
  check(processed && aAfter.players.includes(sendC) && !aAfter.players.includes(sendA), "the accepted trade goes through at once (trigger)");

  console.log("\n9. SETTLEMENT → PLAYOFFS → CHAMPION (real hourly job)");
  // The real job settles on real time, so turn the pre-season simulation clock off.
  await db.collection("admin_settings").doc("simulation_state").set({ testModeActive: false }, { merge: true });
  live.setFetchSummaryForTests(fetchSummary);
  const fns = require("./functions/index.js");
  for (let i = 0; i < 5; i++) await fns.settleMatchupWeeksScheduled.run({});
  live.setFetchSummaryForTests(null);
  lg = await leagueDoc();
  const ts4 = await teams();
  const games = ts4.map(t => (t.wins || 0) + (t.losses || 0) + (t.ties || 0));
  check(games.every(g => g === 3), `every team has a 3-game regular-season record (${games.join(", ")})`);
  check(ts4.reduce((n, t) => n + (t.wins || 0), 0) === ts4.reduce((n, t) => n + (t.losses || 0), 0), "wins equal losses across the league");
  check(ts4.some(t => (t.points || 0) > 0), `teams scored real fantasy points (${ts4.map(t => t.points).join(", ")})`);
  check(lg.playoffs?.status === "complete" && lg.playoffs.championTeamId, `the playoffs finish with a champion (${lg.playoffs?.championTeamId ? ts4.find(t => t.id === lg.playoffs.championTeamId)?.teamName : "none"})`);
} catch (err) {
  console.error("❌ rehearsal stopped:", err.stack || err);
  failures++;
} finally {
  await signOut(auth).catch(() => {});
  live.setFetchSummaryForTests(null);
  // Official games save their summaries, which fire onGameSummaryWritten in the
  // background. Wait for those writes to stop, or they slow and leak into later tests.
  let last = -1;
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const n = (await db.collection("pwhl_season_player_stats").get()).size;
    if (n === last) break;
    last = n;
  }
  if (L.id) await db.recursiveDelete(db.collection("fantasy_leagues").doc(L.id));
  for (const c of ["pwhl_players", "pwhl_teams", "pwhl_games", "pwhl_player_stats", "pwhl_game_summaries", "pwhl_season_player_stats", "game_box_scores", "daily_game_stats", "live_state", "stat_corrections"]) {
    await db.recursiveDelete(db.collection(c));
  }
  for (const id of [REG, PRE]) await db.collection("pwhl_seasons").doc(id).delete();
  await db.collection("app_settings").doc("active_season").delete();
  await db.collection("admin_settings").doc("simulation_state").delete();
  for (const u of USERS) if (u.uid) { await db.collection("users").doc(u.uid).delete(); await adminAuth(adminApp).deleteUser(u.uid).catch(() => {}); }
}
console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
