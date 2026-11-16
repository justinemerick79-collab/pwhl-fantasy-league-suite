/**
 * test-draft-roster-needs.js
 *
 * Covers the auto-draft's handling of roster limits and minimums.
 *
 * Scenario A — the stall. A bot needs a position that no longer exists in the
 * undrafted pool. Every candidate fails the "all minimums still reachable"
 * veto, so the engine used to find nothing draftable, return, and leave the
 * whole draft frozen with that bot on the clock. It must now still pick.
 *
 * Scenario B — the preference. A bot has exactly as many picks left as unmet
 * starter minimums, with a much higher-scoring player available at a position
 * it does not need. It must take the needed position anyway.
 *
 * Run using:
 *   firebase emulators:start --only functions,firestore,auth
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
 *     npx tsx test-draft-roster-needs.js
 */
import { initializeApp } from "firebase/app";
import {
  getAuth, connectAuthEmulator, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, deleteUser
} from "firebase/auth";
import { requireEmulator, createAdminFixtures } from "./test-support.js";

const firebaseConfig = {
  projectId: "pwhl-fantasy-mobile-26",
  appId: "1:502197146749:web:48318c0fda30defd4dcd14",
  storageBucket: "pwhl-fantasy-mobile-26.firebasestorage.app",
  apiKey: "AIzaSyBUpX8nhgUOoBJABs9UNsv0j2GAVL57ZDU",
  authDomain: "pwhl-fantasy-mobile-26.firebaseapp.com",
  messagingSenderId: "502197146749"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const authHostEnv = process.env.FIREBASE_AUTH_EMULATOR_HOST;

requireEmulator("test-draft-roster-needs.js");
const { doc, setDoc, getDoc, deleteDoc, Timestamp } =
  createAdminFixtures(firebaseConfig.projectId, "test-roster-needs");

connectAuthEmulator(auth, `http://${authHostEnv || "127.0.0.1:9099"}`);

const TEST_EMAIL = "rosterneeds_admin_temp@example.com";
const TEST_PASSWORD = "TempPassword123!";
const BOT_UID = "test_bot_roster_needs";
const SEASON_ID = "1";

const createdDocs = [];

async function seedPlayers(players) {
  for (const p of players) {
    const ref = doc(null, "pwhl_players", `${SEASON_ID}_${p.id}`);
    await setDoc(ref, {
      player_id: p.id, id: p.id, season_id: SEASON_ID,
      position: p.pos, name: p.name, points: p.points, rating: 80, isTestNode: true
    });
    createdDocs.push(ref);
  }
}

async function runScenario({ title, leagueId, rosterSettings, botRoster, players, expect }) {
  console.log(`\n══════ ${title}`);
  await seedPlayers(players);

  // The engine treats a missing users/{uid} doc as a human and pauses the draft,
  // so the bot must actually exist and be flagged.
  const botUserRef = doc(null, "users", BOT_UID);
  await setDoc(botUserRef, { email: "bot_roster_needs@test.local", role: "user", isBot: true, isTestNode: true });
  createdDocs.push(botUserRef);

  const leagueRef = doc(null, "fantasy_leagues", leagueId);
  await setDoc(leagueRef, {
    name: title, ownerId: "admin_x", commissionerId: "admin_x",
    status: "drafting", maxTeams: 2, members: [BOT_UID], season_id: SEASON_ID,
    rosterSettings, isTestNode: true
  });
  createdDocs.push(leagueRef);

  const teamRef = doc(null, `fantasy_leagues/${leagueId}/teams`, "team_bot");
  await setDoc(teamRef, { ownerId: BOT_UID, teamName: "Bot Team", players: [...botRoster], isTestNode: true });
  createdDocs.push(teamRef);

  const draftRef = doc(null, `fantasy_leagues/${leagueId}/draft`, "state");
  await setDoc(draftRef, {
    status: "active",
    draftOrder: [BOT_UID],
    currentRound: 1,
    currentPickIndex: botRoster.length,
    currentTeamOnClock: BOT_UID,
    current_pick_owner_id: BOT_UID,
    pickDeadline: Timestamp.fromMillis(Date.now() + 60000),
    // Everything not on the bot's roster and not in `players` is simply absent
    // from the pool, which is how a needed position runs out late in a draft.
    picks: botRoster.map((pid, i) => ({ playerId: pid, pickIndex: i, ownerId: BOT_UID })),
    activeRosters: { [BOT_UID]: [...botRoster] },
    isTestNode: true
  });
  createdDocs.push(draftRef);

  console.log("⏳ waiting 8s for the draft engine (3s think time + transaction)...");
  await new Promise(r => setTimeout(r, 8000));

  const after = await getDoc(draftRef);
  const picks = after.data()?.picks || [];
  const newPicks = picks.slice(botRoster.length);
  return expect({ picks, newPicks });
}

async function main() {
  let testUser = null;
  try {
    console.log("🔑 Authenticating...");
    try {
      testUser = (await signInWithEmailAndPassword(auth, TEST_EMAIL, TEST_PASSWORD)).user;
    } catch {
      testUser = (await createUserWithEmailAndPassword(auth, TEST_EMAIL, TEST_PASSWORD)).user;
    }
    console.log(`✅ ${testUser.email}`);

    const posOf = async (pid) => (await getDoc(doc(null, "pwhl_players", `${SEASON_ID}_${pid}`))).data()?.position;

    // ── A: needed position is unobtainable; the engine must not freeze ──
    const a = await runScenario({
      title: "A: bot needs D, but no D remains in the pool",
      leagueId: "rn_test_stall",
      // 3 roster spots: 1 F, 1 D, 1 G required.
      rosterSettings: { bench: 0, forwards: { starters: 1, max: 5 }, defense: { starters: 1, max: 5 }, goalies: { starters: 1, max: 5 } },
      botRoster: ["rn_f1", "rn_f2"],          // 2 F taken, 1 pick left, D and G both unmet
      players: [
        { id: "rn_f1", pos: "F", points: 10, name: "Rostered F1" },
        { id: "rn_f2", pos: "F", points: 10, name: "Rostered F2" },
        { id: "rn_f3", pos: "F", points: 50, name: "Available F3" }, // only F left in the pool
      ],
      expect: ({ newPicks }) => {
        console.log(`- new picks: ${newPicks.length} (${newPicks.map(p => p.playerId).join(", ") || "none"})`);
        if (newPicks.length === 0) throw new Error("A FAILED: draft stalled — bot made no pick");
        console.log("⭐ A PASSED: bot still picked instead of freezing the draft");
        return true;
      }
    });

    // ── B: slack exhausted; must take the needed position over a better player ──
    const b = await runScenario({
      title: "B: must take a needed D over a far higher-scoring F",
      leagueId: "rn_test_pref",
      // 4 roster spots: 1 F, 1 D, 1 G required, 1 bench.
      rosterSettings: { bench: 1, forwards: { starters: 1, max: 5 }, defense: { starters: 1, max: 5 }, goalies: { starters: 1, max: 5 } },
      botRoster: ["rn2_f1", "rn2_f2"],        // F=2, D=0, G=0 → 2 picks left, 2 unmet minimums
      players: [
        { id: "rn2_f1", pos: "F", points: 10, name: "Rostered F1" },
        { id: "rn2_f2", pos: "F", points: 10, name: "Rostered F2" },
        { id: "rn2_f3", pos: "F", points: 999, name: "Superstar F" }, // highest points by far
        { id: "rn2_d1", pos: "D", points: 5, name: "Modest D" },
        { id: "rn2_g1", pos: "G", points: 5, name: "Modest G" },
      ],
      expect: async ({ newPicks }) => {
        if (newPicks.length === 0) throw new Error("B FAILED: bot made no pick");
        const pickedPos = await posOf(newPicks[0].playerId);
        console.log(`- picked: ${newPicks[0].playerId} (${pickedPos}); Superstar F was available at 999 pts`);
        if (pickedPos === "F") {
          throw new Error(`B FAILED: took the higher-scoring F instead of a needed position`);
        }
        console.log(`⭐ B PASSED: took a needed position (${pickedPos}) over the superstar F`);
        return true;
      }
    });

    if (a && b) console.log("\n🏆 STATUS: PASS - ROSTER NEEDS AND STALL ASSERTIONS PASSED!");
  } catch (err) {
    console.log(`\n❌ STATUS: FAIL - ${err.message}`);
  } finally {
    console.log("\n🧹 Cleaning up...");
    for (const ref of createdDocs) { try { await deleteDoc(ref); } catch { /* already gone */ } }
    if (testUser) { try { await deleteUser(testUser); } catch { /* fine */ } }
    console.log("✅ Cleanup complete.");
  }
}

main();
