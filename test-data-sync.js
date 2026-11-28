/**
 * test-data-sync.js
 *
 * The admin "Sync" button calls the runDataSync Cloud Function (functions/dataSync.js),
 * so the sync works on the deployed site. This signs in as an admin, calls it exactly
 * as the Admin Panel does for the small 2026-27 preseason (season 10), and checks every
 * collection the old browser sync wrote. Reads the live PWHL feed; writes only to the
 * emulator, then removes what it wrote.
 *
 *   firebase emulators:exec --only functions,firestore,auth "npx tsx test-data-sync.js"
 */
import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signInWithEmailAndPassword, deleteUser } from "firebase/auth";
import { getFunctions, connectFunctionsEmulator, httpsCallable } from "firebase/functions";
import { requireEmulator, createAdminFixtures } from "./test-support.js";

requireEmulator("test-data-sync.js");
const app = initializeApp({ projectId: "pwhl-fantasy-mobile-26", apiKey: "AIzaSyBUpX8nhgUOoBJABs9UNsv0j2GAVL57ZDU", authDomain: "pwhl-fantasy-mobile-26.firebaseapp.com", appId: "1:502197146749:web:48318c0fda30defd4dcd14" });
const auth = getAuth(app);
connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`);
const functions = getFunctions(app, "us-central1");
connectFunctionsEmulator(functions, "127.0.0.1", 5001);
const { adminDb: db } = createAdminFixtures("pwhl-fantasy-mobile-26", "test-data-sync");

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "✅" : "❌"} ${label}`); if (!ok) failures++; };
const SEASON = "10";
const count = async (col, field = "season_id") => (await db.collection(col).where(field, "==", SEASON).get()).size;

let user = null;
try {
  const email = "data_sync_admin_temp@example.com", pw = "TempPassword123!";
  try { user = (await createUserWithEmailAndPassword(auth, email, pw)).user; } catch { user = (await signInWithEmailAndPassword(auth, email, pw)).user; }
  await db.collection("users").doc(user.uid).set({ email, role: "admin", isTestNode: true });

  console.log("\nFIRST RUN (as the Admin Panel calls it)");
  const sync = httpsCallable(functions, "runDataSync", { timeout: 600000 });
  const res = await sync({ seasonId: SEASON });
  const log = res.data?.log || [];
  console.log(log.map(l => `   │ ${l}`).join("\n"));
  check(log.some(l => /Sync complete/.test(l)), "the function returns its log to the panel");
  check((await count("pwhl_teams")) > 0, `teams written (${await count("pwhl_teams")})`);
  check((await count("pwhl_players")) > 0, `rostered players written (${await count("pwhl_players")})`);
  check((await count("pwhl_games")) > 0, `games written (${await count("pwhl_games")})`);
  const season = (await db.collection("pwhl_seasons").doc(SEASON).get()).data() || {};
  const placed = (season.weeks || []).reduce((n, w) => n + w.gameCount, 0);
  check(season.weeks?.length > 0 && placed === (await count("pwhl_games")), `season document and week map written (${season.weeks?.length} weeks, ${placed} games placed)`);
  check(season.start_date && !/06-01$/.test(season.start_date), `season dates come from the feed, not the old placeholder list (${season.start_date} → ${season.end_date})`);
  const finals = (await db.collection("pwhl_games").where("season_id", "==", SEASON).where("status", "==", "4").get()).size;
  const summaries = (await db.collection("pwhl_game_summaries").where("season_id", "==", SEASON).get()).docs;
  check(summaries.length > 0 && summaries.length <= finals && summaries.every(d => d.data().home_team_lineup), `game summaries downloaded and usable (${summaries.length} of ${finals} finished games)`);
  check((await count("pwhl_player_stats")) > 0, `player stat lines written (${await count("pwhl_player_stats")})`);

  console.log("\nSECOND RUN");
  const res2 = await sync({ seasonId: SEASON });
  const line = (res2.data?.log || []).find(l => /game summaries:/.test(l)) || "";
  check(/0 downloaded/.test(line) || (summaries.length < finals && /downloaded/.test(line)), `a second run does not re-download stored summaries ("${line.trim()}")`);
} catch (err) {
  console.error("❌ unexpected error:", err.message || err);
  failures++;
} finally {
  // Each stored summary fires onGameSummaryWritten, which writes season totals in the
  // background. Wait until those writes stop, or they land after the cleanup and leak
  // into the next test.
  let last = -1;
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const n = (await db.collection("pwhl_season_player_stats").get()).size;
    if (n === last) break;
    last = n;
  }
  for (const c of ["pwhl_teams", "pwhl_players", "pwhl_games", "pwhl_game_summaries", "pwhl_player_stats", "pwhl_seasons", "pwhl_season_player_stats", "live_state"]) {
    await db.recursiveDelete(db.collection(c));
  }
  if (user) { await db.collection("users").doc(user.uid).delete().catch(() => {}); await deleteUser(user).catch(() => {}); }
}
console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
