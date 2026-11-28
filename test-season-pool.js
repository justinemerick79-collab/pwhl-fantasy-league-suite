/**
 * test-season-pool.js
 *
 * Every reader uses ONE season player pool ("universe").
 *
 * 1. The fallback rule — `resolveUniverseSeason` in src/services/pwhlService.js
 *    and its server copy in functions/universeSeason.js — returns the season
 *    itself when it has players, and the latest earlier regular season when it
 *    has none. Both copies must agree on every case.
 * 2. The server bot draft engine drafts only from the league's season: a far
 *    higher-scoring player whose doc belongs to another season is never taken,
 *    and the pick records the bare player id, not the "<season>_<player>" doc id.
 *    A league whose season has no players drafts from the fallback season.
 * 3. `submitDraftPick` (client) reads the "<season>_<player>" doc, so a
 *    defender's pick stores position D. Its numeric id would have been counted
 *    as F by the old made-up id-range rule. A league without season_id finds
 *    the player through a query on player_id.
 *
 * Run using:
 *   firebase emulators:exec --only functions,firestore,auth "npx tsx test-season-pool.js"
 */
import { createRequire } from "node:module";
import { connectAuthEmulator, signInWithEmailAndPassword, createUserWithEmailAndPassword, deleteUser } from "firebase/auth";
import { connectFirestoreEmulator } from "firebase/firestore";
import { requireEmulator, emulatorHosts, createAdminFixtures } from "./test-support.js";
import { db as clientDb, auth } from "./src/firebase.js";
import { submitDraftPick } from "./src/services/leagueService.js";
import { resolveUniverseSeason } from "./src/services/pwhlService.js";

const require = createRequire(import.meta.url);
const { resolveUniverseSeason: resolveUniverseSeasonServer } = require("./functions/universeSeason.js");

requireEmulator("test-season-pool.js");

const hosts = emulatorHosts();
connectFirestoreEmulator(clientDb, hosts.firestore.host, hosts.firestore.port);
connectAuthEmulator(auth, hosts.authUrl);

const { doc, setDoc, getDoc, deleteDoc, Timestamp } =
  createAdminFixtures("pwhl-fantasy-mobile-26", "test-season-pool");

const TEST_EMAIL = "seasonpool_temp@example.com";
const TEST_PASSWORD = "TempPassword123!";
const BOT_UID = "test_bot_season_pool";

// Far-future seasons so real or leftover season docs never sort between them.
const OLD_SEASON = "9900";   // regular, has the superstar
const LEAGUE_SEASON = "9901"; // regular, the league's pool
const EMPTY_SEASON = "9902";  // regular, no players yet → falls back to 9901

const SEASONS = [
  { season_id: OLD_SEASON, start_date: "2089-10-01", playoff: "0", career: "1" },
  { season_id: LEAGUE_SEASON, start_date: "2090-10-01", playoff: "0", career: "1" },
  { season_id: "9901p", start_date: "2091-04-01", playoff: "1", career: "1" }, // playoffs: never a fallback
  { season_id: "9901x", start_date: "2091-06-01", playoff: "0", career: "0" }, // non-career: never a fallback
  { season_id: EMPTY_SEASON, start_date: "2091-10-01", playoff: "0", career: "1" },
];

const PLAYERS = [
  { season: OLD_SEASON, id: "990001", pos: "F", points: 999, name: "Old Season Superstar" },
  { season: LEAGUE_SEASON, id: "990101", pos: "F", points: 10, name: "League F" },
  { season: LEAGUE_SEASON, id: "990108", pos: "D", points: 20, name: "League D" },
];

const createdDocs = [];
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "⭐ PASS" : "❌ FAIL"}: ${label}`);
  if (!ok) failures++;
};

async function seed() {
  for (const s of SEASONS) {
    const ref = doc(null, "pwhl_seasons", s.season_id);
    await setDoc(ref, { ...s, isTestNode: true });
    createdDocs.push(ref);
  }
  for (const p of PLAYERS) {
    const ref = doc(null, "pwhl_players", `${p.season}_${p.id}`);
    await setDoc(ref, {
      player_id: p.id, season_id: p.season, position: p.pos, name: p.name,
      points: p.points, rating: 80, isTestNode: true,
    });
    createdDocs.push(ref);
  }
}

function testHelper() {
  console.log("\n══════ 1: one fallback rule, client and server");
  const cases = [
    { label: "season with players uses itself", args: [LEAGUE_SEASON, SEASONS, true], expect: { seasonId: LEAGUE_SEASON, isFallback: false } },
    { label: "empty season uses the latest earlier regular season", args: [EMPTY_SEASON, SEASONS, false], expect: { seasonId: LEAGUE_SEASON, isFallback: true } },
    { label: "numeric id is accepted", args: [Number(EMPTY_SEASON), SEASONS, false], expect: { seasonId: LEAGUE_SEASON, isFallback: true } },
    { label: "empty season with no earlier regular season keeps itself", args: [OLD_SEASON, SEASONS, false], expect: { seasonId: OLD_SEASON, isFallback: false } },
    { label: "no seasons list keeps itself", args: [EMPTY_SEASON, [], false], expect: { seasonId: EMPTY_SEASON, isFallback: false } },
  ];
  for (const c of cases) {
    const client = resolveUniverseSeason(...c.args);
    const server = resolveUniverseSeasonServer(...c.args);
    const want = JSON.stringify(c.expect);
    check(JSON.stringify(client) === want, `client: ${c.label} → ${JSON.stringify(client)}`);
    check(JSON.stringify(server) === want, `server: ${c.label} → ${JSON.stringify(server)}`);
  }
}

async function runBotDraft(leagueId, seasonId) {
  const leagueRef = doc(null, "fantasy_leagues", leagueId);
  await setDoc(leagueRef, {
    name: leagueId, ownerId: "admin_x", commissionerId: "admin_x",
    status: "drafting", maxTeams: 1, members: [BOT_UID], season_id: seasonId,
    rosterSettings: { bench: 1, forwards: { starters: 0, max: 5 }, defense: { starters: 0, max: 5 }, goalies: { starters: 0, max: 5 } },
    isTestNode: true,
  });
  createdDocs.push(leagueRef);

  const teamRef = doc(null, `fantasy_leagues/${leagueId}/teams`, "team_bot");
  await setDoc(teamRef, { ownerId: BOT_UID, teamName: "Bot Team", players: [], isTestNode: true });
  createdDocs.push(teamRef);

  const draftRef = doc(null, `fantasy_leagues/${leagueId}/draft`, "state");
  await setDoc(draftRef, {
    status: "active", draftOrder: [BOT_UID], currentRound: 1, currentPickIndex: 0,
    currentTeamOnClock: BOT_UID, current_pick_owner_id: BOT_UID,
    pickDeadline: Timestamp.fromMillis(Date.now() + 60000),
    picks: [], activeRosters: { [BOT_UID]: [] }, isTestNode: true,
  });
  createdDocs.push(draftRef);

  console.log(`⏳ ${leagueId}: waiting for the draft engine (3s think time + transaction)...`);
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const picks = (await getDoc(draftRef)).data()?.picks || [];
    if (picks.length > 0) return picks[0];
  }
  return null;
}

async function testBotEngine() {
  console.log("\n══════ 2: bot draft engine uses the league's season only");
  const botUserRef = doc(null, "users", BOT_UID);
  await setDoc(botUserRef, { email: "bot_season_pool@test.local", role: "user", isBot: true, isTestNode: true });
  createdDocs.push(botUserRef);

  const pick = await runBotDraft("sp_test_league_season", LEAGUE_SEASON);
  check(!!pick, "bot made a pick");
  if (pick) {
    check(pick.player_id === "990108",
      `picked the league season's best player 990108, not the old-season superstar 990001 (got ${pick.player_id})`);
    check(pick.playerId === pick.player_id && !String(pick.player_id).includes("_"),
      `pick stores the bare player id (playerId=${pick.playerId})`);
  }

  const fallbackPick = await runBotDraft("sp_test_empty_season", EMPTY_SEASON);
  check(fallbackPick?.player_id === "990108",
    `empty season ${EMPTY_SEASON} drafts from fallback season ${LEAGUE_SEASON} (got ${fallbackPick?.player_id})`);
}

async function runClientPick(user, leagueId, seasonId, playerId) {
  const leagueRef = doc(null, "fantasy_leagues", leagueId);
  const league = {
    name: leagueId, ownerId: user.uid, commissionerId: user.uid, status: "drafting",
    maxTeams: 1, members: [user.uid],
    rosterSettings: { bench: 1, forwards: { starters: 0, max: 5 }, defense: { starters: 0, max: 5 }, goalies: { starters: 0, max: 5 } },
    isTestNode: true,
  };
  if (seasonId) league.season_id = seasonId;
  await setDoc(leagueRef, league);
  createdDocs.push(leagueRef);

  const teamRef = doc(null, `fantasy_leagues/${leagueId}/teams`, "team_user");
  await setDoc(teamRef, { ownerId: user.uid, teamName: "User Team", players: [], activePlayers: [], benchPlayers: [], isTestNode: true });
  createdDocs.push(teamRef);

  const draftRef = doc(null, `fantasy_leagues/${leagueId}/draft`, "state");
  await setDoc(draftRef, {
    status: "active", draftOrder: [user.uid], currentRound: 1, currentPickIndex: 0,
    currentTeamOnClock: user.uid, pickDeadline: Timestamp.fromMillis(Date.now() + 60000),
    picks: [], activeRosters: { [user.uid]: [] }, isTestNode: true,
  });
  createdDocs.push(draftRef);

  await submitDraftPick(leagueId, user.uid, playerId);
  return ((await getDoc(draftRef)).data()?.picks || [])[0];
}

async function testClientPick(user) {
  console.log("\n══════ 3: submitDraftPick stores the real position");
  const pick = await runClientPick(user, "sp_test_client_pick", LEAGUE_SEASON, "990108");
  check(pick?.position === "D", `defender 990108 in a season-${LEAGUE_SEASON} league stored as ${pick?.position}`);

  const noSeasonPick = await runClientPick(user, "sp_test_client_noseason", null, "990108");
  check(noSeasonPick?.position === "D", `defender 990108 in a league without season_id stored as ${noSeasonPick?.position}`);
}

async function main() {
  let testUser = null;
  try {
    try {
      testUser = (await signInWithEmailAndPassword(auth, TEST_EMAIL, TEST_PASSWORD)).user;
    } catch {
      testUser = (await createUserWithEmailAndPassword(auth, TEST_EMAIL, TEST_PASSWORD)).user;
    }
    const userRef = doc(null, "users", testUser.uid);
    await setDoc(userRef, { email: TEST_EMAIL, role: "user", isTestNode: true });
    createdDocs.push(userRef);

    await seed();
    testHelper();
    await testBotEngine();
    await testClientPick(testUser);
  } catch (err) {
    failures++;
    console.log(`❌ ERROR: ${err.stack || err.message}`);
  } finally {
    console.log("\n🧹 Cleaning up...");
    for (const ref of createdDocs.reverse()) { try { await deleteDoc(ref); } catch { /* already gone */ } }
    if (testUser) { try { await deleteUser(testUser); } catch { /* fine */ } }
  }
  if (failures > 0) {
    console.log(`\n❌ STATUS: FAIL - ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\n🏆 STATUS: PASS - ONE SEASON PLAYER POOL");
  process.exit(0);
}

main();
