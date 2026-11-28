/**
 * test-server-transactions.js
 *
 * Waivers and accepted trades are processed on the server
 * (functions/transactions.js). Replaces test-transactions-engine.js, which
 * drove the old client functions against production.
 *
 *   firebase emulators:exec --only functions,firestore,auth "npx tsx test-server-transactions.js"
 */
import { createRequire } from "module";
import { requireEmulator } from "./test-support.js";

requireEmulator("test-server-transactions.js");
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || "pwhl-fantasy-mobile-26";

const require = createRequire(import.meta.url);
const { processLeagueWaivers, processLeagueTrades } = require("./functions/transactions.js");
// Use the same firebase-admin copy as functions/ — a Timestamp from one copy is
// rejected by a Firestore handle from the other.
const fnRequire = createRequire(new URL("./functions/index.js", import.meta.url));
const { initializeApp } = fnRequire("firebase-admin/app");
const { getFirestore, Timestamp } = fnRequire("firebase-admin/firestore");
const db = getFirestore(initializeApp({ projectId: "pwhl-fantasy-mobile-26" }, "test-server-transactions"));

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "✅" : "❌"} ${label}`); if (!ok) failures++; };
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const H = 3600 * 1000;
const NOW = Date.now();
const ts = (msOffset) => Timestamp.fromMillis(NOW + msOffset);
const leagues = [];

// Max roster = bench 1 + F 2 + D 1 + G 1 = 5
const ROSTER = { bench: 1, forwards: { starters: 2 }, defense: { starters: 1 }, goalies: { starters: 1 } };

async function makeLeague(id, { teams, waiverOrder, undroppable = [], tradeSettings, status = "active" }) {
  const ref = db.collection("fantasy_leagues").doc(id);
  await ref.set({ name: id, status, isTestNode: true, rosterSettings: ROSTER, waiverOrder, undroppable_players: undroppable, ...(tradeSettings ? { tradeSettings } : {}) });
  for (const [tid, players] of Object.entries(teams)) {
    await ref.collection("teams").doc(tid).set({ teamName: tid, ownerId: `owner_${tid}`, players });
  }
  leagues.push(ref);
  return ref;
}
const waiver = (ref, playerId, offsetMs) => ref.collection("waivers").doc(playerId).set({ playerId, waiverDeadline: ts(offsetMs), createdAt: ts(-48 * H) });
const claim = (ref, teamId, playerId, dropPlayerId = null, ageMs = -10 * H) =>
  ref.collection("waiver_claims").doc(`${teamId}_${playerId}`).set({ teamId, userId: `owner_${teamId}`, playerId, dropPlayerId, createdAt: ts(ageMs) });
const players = async (ref, tid) => (await ref.collection("teams").doc(tid).get()).data().players;
const exists = async (ref, col, id) => (await ref.collection(col).doc(id).get()).exists;

async function waivers() {
  console.log("\nWAIVERS");
  const L = await makeLeague("test_tx_waivers", {
    waiverOrder: ["A", "B", "C", "D"],
    undroppable: ["u1"],
    teams: { A: ["a1", "a2"], B: ["b1"], C: ["c1", "c2", "c3", "c4", "u1"], D: ["d1"] },
  });
  // Two waivers expire together and team A (top priority) claims both — the
  // client failed outright here, and would have kept only one of A's wins.
  await waiver(L, "p1", -1 * H); await claim(L, "A", "p1");
  await waiver(L, "p2", -1 * H + 1); await claim(L, "A", "p2");
  // After A wins p1 and p2, A is last: B now outranks A for p3.
  await waiver(L, "p3", -1 * H + 2); await claim(L, "A", "p3"); await claim(L, "B", "p3");
  // C's roster is full and its drop is undroppable → invalid; D is next.
  await waiver(L, "p4", -1 * H + 3); await claim(L, "C", "p4", "u1"); await claim(L, "D", "p4", "d1");
  // No claims → free agent.
  await waiver(L, "p5", -1 * H + 4);
  // Not expired yet → untouched.
  await waiver(L, "p6", +5 * H); await claim(L, "B", "p6");

  const out = await processLeagueWaivers(db, L.id, NOW);
  check(out.expired === 5, `5 expired waivers processed together (${out.expired})`);
  check(same(await players(L, "A"), ["a1", "a2", "p1", "p2"]), `team A keeps BOTH wins: ${await players(L, "A")}`);
  check(same(await players(L, "B"), ["b1", "p3"]), `priority rotates — B beats A for p3: ${await players(L, "B")}`);
  check(same(await players(L, "C"), ["c1", "c2", "c3", "c4", "u1"]), "C's claim with an undroppable drop is skipped");
  check(same(await players(L, "D"), ["p4"]), `next claimant D wins p4, dropping d1: ${await players(L, "D")}`);
  const d1 = (await L.collection("waivers").doc("d1").get()).data();
  check(d1 && Math.abs(d1.waiverDeadline.toMillis() - (NOW + 48 * H)) < 1000, "D's dropped player goes on waivers for 48 hours");
  check(out.freeAgents.includes("p5") && !(await exists(L, "waivers", "p5")), "p5 with no claims becomes a free agent");
  check(!(await exists(L, "waivers", "p1")) && !(await exists(L, "waiver_claims", "A_p1")), "processed waivers and their claims are removed");
  check((await exists(L, "waivers", "p6")) && (await exists(L, "waiver_claims", "B_p6")), "an unexpired waiver and its claim are left alone");
  const order = (await L.get()).data().waiverOrder;
  check(JSON.stringify(order) === JSON.stringify(["C", "A", "B", "D"]), `waiver order after A, A, B, D win: ${order}`);

  const again = await processLeagueWaivers(db, L.id, NOW);
  check(again.expired === 0, "a second run finds nothing to do");
}

async function trades() {
  console.log("\nTRADES");
  const L = await makeLeague("test_tx_trades", {
    waiverOrder: ["P", "R"], tradeSettings: { vetoThreshold: 2 },
    teams: { P: ["x1", "x2", "x3"], R: ["y1", "y2"] },
  });
  const trade = (id, data) => L.collection("trades").doc(id).set({ tradeId: id, proposerTeamId: "P", receiverTeamId: "R", vetoes: [], ...data });
  await trade("ready", { status: "accepted", processDeadline: ts(-1 * H), proposerSends: ["x1"], receiverSends: ["y1"], proposerDrops: ["x2"] });
  await trade("waiting", { status: "accepted", processDeadline: ts(+5 * H), proposerSends: ["x3"], receiverSends: ["y2"] });
  await trade("vetoed", { status: "accepted", processDeadline: ts(-1 * H), vetoes: ["u1", "u2"], proposerSends: ["x3"], receiverSends: ["y2"] });
  await trade("gone", { status: "accepted", processDeadline: ts(-1 * H), proposerSends: ["nobody"], receiverSends: ["y2"] });

  const out = await processLeagueTrades(db, L.id, NOW);
  check(out.ready === "processed", `ready trade processed (${out.ready})`);
  check(same(await players(L, "P"), ["x3", "y1"]) && same(await players(L, "R"), ["y2", "x1"]), "players swapped and P's drop removed");
  check(await exists(L, "waivers", "x2"), "P's dropped player goes on waivers");
  check(out.waiting === "waiting" && (await L.collection("trades").doc("waiting").get()).data().status === "accepted", "trade still in review is left waiting");
  check(out.vetoed === "vetoed", `trade at the veto threshold is vetoed (${out.vetoed})`);
  check(out.gone === "voided", `trade whose player is gone is voided (${out.gone})`);

  // A second run must leave a processed trade alone. (The in-transaction
  // status re-check that guards two concurrent runs is not exercised here.)
  const again = await processLeagueTrades(db, L.id, NOW);
  check(!("ready" in again) && (await L.collection("trades").doc("ready").get()).data().status === "processed",
    "a processed trade is not processed again on a second run");
}

async function triggers() {
  console.log("\nTRIGGER AND SCHEDULE");
  // accepted_immediate → onTradeWritten (functions emulator) processes it at once.
  const L = await makeLeague("test_tx_immediate", { waiverOrder: ["P", "R"], teams: { P: ["m1"], R: ["n1"] } });
  await L.collection("trades").doc("now").set({ tradeId: "now", proposerTeamId: "P", receiverTeamId: "R", vetoes: [], status: "accepted_immediate", proposerSends: ["m1"], receiverSends: ["n1"] });
  let status = null;
  for (let i = 0; i < 40 && status !== "processed"; i++) {
    await new Promise(r => setTimeout(r, 500));
    status = (await L.collection("trades").doc("now").get()).data().status;
  }
  check(status === "processed" && same(await players(L, "P"), ["n1"]), `accepted_immediate trade processed by the trigger (${status})`);

  // An idle league: nobody opens the app; the scheduled job clears its waiver.
  const I = await makeLeague("test_tx_idle", { waiverOrder: ["A"], teams: { A: [] } });
  await waiver(I, "q1", -1 * H); await claim(I, "A", "q1");
  const fns = require("./functions/index.js");
  await fns.processTransactionsScheduled.run({});
  check(same(await players(I, "A"), ["q1"]), "scheduled job clears an idle league's expired waiver");
}

try {
  await waivers();
  await trades();
  await triggers();
} finally {
  for (const ref of leagues) await db.recursiveDelete(ref);
}
console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
