/**
 * test-playoffs.js
 *
 * Playoffs (functions/playoffs.js): seeding, byes, rounds and champion.
 * Part 1 checks the pure bracket rules. Part 2 runs the real weekly settlement
 * job (settleMatchupWeeksScheduled) one week at a time on the emulator, from the
 * last regular-season week through the final.
 *
 *   firebase emulators:exec --only functions,firestore,auth "npx tsx test-playoffs.js"
 */
import { createRequire } from "module";
import { requireEmulator } from "./test-support.js";

requireEmulator("test-playoffs.js");
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || "pwhl-fantasy-mobile-26";

const require = createRequire(import.meta.url);
const { seedTeams, pairRound, playoffWinner, roundCount, afterWeekSettled } = require("./functions/playoffs.js");
const fnRequire = createRequire(new URL("./functions/index.js", import.meta.url));
const { initializeApp } = fnRequire("firebase-admin/app");
const { getFirestore } = fnRequire("firebase-admin/firestore");
const db = getFirestore(initializeApp({ projectId: "pwhl-fantasy-mobile-26" }, "test-playoffs"));

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "✅" : "❌"} ${label}`); if (!ok) failures++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function part1() {
  console.log("\nPART 1 — bracket rules");
  const seeds = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"];
  const seedOf = Object.fromEntries(seeds.map((id, i) => [id, i + 1]));
  check(eq(pairRound(seeds.slice(0, 4), seedOf, 0).pairs, [["s1", "s4"], ["s2", "s3"]]), "4 teams: 1 v 4, 2 v 3");
  check(eq(pairRound(seeds, seedOf, 0).pairs, [["s1", "s8"], ["s2", "s7"], ["s3", "s6"], ["s4", "s5"]]), "8 teams: 1 v 8, 2 v 7, 3 v 6, 4 v 5");
  const six = pairRound(seeds.slice(0, 6), seedOf, 2 ** roundCount(6) - 6);
  check(eq(six.byes, ["s1", "s2"]) && eq(six.pairs, [["s3", "s6"], ["s4", "s5"]]), "6 teams: seeds 1 and 2 bye; 3 v 6, 4 v 5");
  check(roundCount(4) === 2 && roundCount(6) === 3 && roundCount(8) === 3, "rounds: 4 → 2, 6 → 3, 8 → 3");
  const order = seedTeams([
    { id: "a", wins: 5, losses: 5, ties: 0, points: 900 },
    { id: "b", wins: 5, losses: 4, ties: 1, points: 100 },  // .55 beats .50
    { id: "c", wins: 5, losses: 5, ties: 0, points: 950 },  // same pct as a, more points
    { id: "d", wins: 0, losses: 0, ties: 0, points: 0 },
  ]);
  check(eq(order, ["b", "c", "a", "d"]), `seeding: win % (tie = half), then points (${order})`);
  const m = { homeTeamId: "h", awayTeamId: "w", homeSeed: 2, awaySeed: 7 };
  check(playoffWinner(m, 50, 60) === "w", "higher score wins, even as the lower seed");
  check(playoffWinner(m, 40, 40) === "h", "a tie goes to the higher seed");
}

async function part2() {
  console.log("\nPART 2 — real settlement job, week by week");
  const DAY = 86400000, now = Date.now();
  const weeks = Array.from({ length: 6 }, (_, i) => ({
    week: i + 1, isOffWeek: false, gameCount: 1,
    start: new Date(now - (60 - i * 7) * DAY).toISOString(),
    end: new Date(now - (53 - i * 7) * DAY).toISOString(),
  }));
  const seasonRef = db.collection("pwhl_seasons").doc("test_po_season");
  const L = db.collection("fantasy_leagues").doc("test_po_league");
  const short = db.collection("fantasy_leagues").doc("test_po_short");
  try {
    await seasonRef.set({ weeks, isTestNode: true });
    await L.set({
      name: "Playoff Test", status: "active", season_id: "test_po_season", currentWeek: 1, isTestNode: true,
      scheduleSettings: { matchupDuration: 1, playoffTeams: 6, playoffDuration: 1 },
      schedule: { regularSeasonWeeks: [1, 2, 3], playoffWeeks: [4, 5, 6] },
    });
    // 7 teams with fixed records: T1 best … T7 worst. T7 misses the playoffs.
    for (let i = 1; i <= 7; i++) {
      await L.collection("teams").doc(`T${i}`).set({ teamName: `Team ${i}`, ownerId: `o${i}`, players: [], wins: 10 - i, losses: i, ties: 0, points: 1000 - i });
    }

    const fns = require("./functions/index.js");
    const settle = () => fns.settleMatchupWeeksScheduled.run({});
    const league = async () => (await L.get()).data();
    const roundGames = async (w) => (await L.collection("matchups").where("week", "==", w).where("isPlayoff", "==", true).get()).docs.map(d => d.data());
    const pairsOf = (games) => games.map(g => [g.homeTeamId, g.awayTeamId]).sort((a, b) => a[0].localeCompare(b[0]));

    for (let i = 0; i < 3; i++) await settle();   // weeks 1-3: regular season
    let lg = await league();
    check(lg.playoffs?.status === "in_progress", `playoffs start after the last regular week (${lg.playoffs?.status})`);
    check(eq(lg.playoffs?.seeds, ["T1", "T2", "T3", "T4", "T5", "T6"]), `top 6 seeded by record: ${lg.playoffs?.seeds}`);
    check(eq(lg.playoffs?.byes, ["T1", "T2"]), `seeds 1 and 2 have a bye: ${lg.playoffs?.byes}`);
    let g = await roundGames(4);
    check(eq(pairsOf(g), [["T3", "T6"], ["T4", "T5"]]), `round 1 (week 4): 3 v 6, 4 v 5 — ${JSON.stringify(pairsOf(g))}`);
    check(g.every(x => x.homeSeed < x.awaySeed && x.round === 1), "higher seed is home; round recorded");

    await settle();                                // week 4 (no points: ties → higher seed)
    g = await roundGames(4);
    check(g.every(x => x.status === "completed") && eq(g.map(x => x.winnerId).sort(), ["T3", "T4"]), "round 1 settles; tied games go to the higher seed");
    g = await roundGames(5);
    check(eq(pairsOf(g), [["T1", "T4"], ["T2", "T3"]]), `round 2 (week 5) re-seeds: 1 v 4, 2 v 3 — ${JSON.stringify(pairsOf(g))}`);

    await settle();                                // week 5
    g = await roundGames(6);
    check(eq(pairsOf(g), [["T1", "T2"]]), `final (week 6): 1 v 2 — ${JSON.stringify(pairsOf(g))}`);

    await settle();                                // week 6
    lg = await league();
    check(lg.playoffs?.status === "complete" && lg.playoffs?.championTeamId === "T1", `champion recorded: ${lg.playoffs?.championTeamId}`);
    const t1 = (await L.collection("teams").doc("T1").get()).data();
    check(t1.wins === 9 && t1.losses === 1 && t1.ties === 0, `playoff games leave the standings alone (T1 ${t1.wins}-${t1.losses}-${t1.ties})`);
    check((await afterWeekSettled(db, L.id, 6)) === "nothing to do", "running the playoff step again does nothing");

    // A league whose season is too short for its bracket gets no playoffs, cleanly.
    await short.set({ name: "Short", status: "draft", season_id: "test_po_season", isTestNode: true,
      scheduleSettings: { playoffTeams: 8 }, schedule: { regularSeasonWeeks: [1, 2, 3], playoffWeeks: [4, 5] } });
    for (let i = 1; i <= 8; i++) await short.collection("teams").doc(`S${i}`).set({ teamName: `S${i}`, wins: 0, losses: 0 });
    await afterWeekSettled(db, short.id, 3);
    const sp = (await short.get()).data().playoffs;
    check(sp?.status === "none" && /not enough/.test(sp.reason), `too few playoff weeks → no playoffs, with a reason (${sp?.reason})`);
  } finally {
    await db.recursiveDelete(L);
    await db.recursiveDelete(short);
    await seasonRef.delete();
  }
}

part1();
await part2();
console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
