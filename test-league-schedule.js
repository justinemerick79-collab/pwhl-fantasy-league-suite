/**
 * test-league-schedule.js
 *
 * A real (non-simulation) league must get a regular-season matchup schedule
 * when its draft completes (functions/schedule.js, wired into onDraftWritten).
 *
 * Part 1 checks the pure planner. Part 2 drives the real trigger on the
 * emulator: it writes a completed draft document and waits for the matchups.
 *
 *   firebase emulators:exec --only functions,firestore,auth "npx tsx test-league-schedule.js"
 */
import { createRequire } from "module";
import { requireEmulator, createAdminFixtures } from "./test-support.js";

requireEmulator("test-league-schedule.js");
const require = createRequire(import.meta.url);
const { planSchedule, buildRoundRobin } = require("./functions/schedule.js");
const { adminDb, Timestamp } = createAdminFixtures("pwhl-fantasy-mobile-26", "test-league-schedule");

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "✅" : "❌"} ${label}`);
  if (!ok) failures++;
};

const DAY = 24 * 3600 * 1000;
const NOW = Date.now();
/** 16 weekly blocks: weeks 1-2 already started, week 6 is an off week. */
function makeWeeks() {
  // Week 1 started 13 days ago, week 2 six days ago; week 3 starts tomorrow.
  const firstStart = NOW - 13 * DAY;
  return Array.from({ length: 16 }, (_, i) => ({
    week: i + 1,
    start: new Date(firstStart + i * 7 * DAY).toISOString(),
    end: new Date(firstStart + i * 7 * DAY + 7 * DAY - 1).toISOString(),
    isOffWeek: i + 1 === 6,
    gameCount: i + 1 === 6 ? 0 : 6,
  }));
}

function weekBookingOk(matchups) {
  const byWeek = {};
  for (const m of matchups) {
    byWeek[m.week] = byWeek[m.week] || new Set();
    for (const t of [m.homeTeamId, m.awayTeamId]) {
      if (byWeek[m.week].has(t)) return false;
      byWeek[m.week].add(t);
    }
  }
  return true;
}

function part1() {
  console.log("\nPART 1 — planner");
  const weeks = makeWeeks();
  const six = ["a", "b", "c", "d", "e", "f"];

  const p = planSchedule({ teamIds: six, seasonWeeks: weeks, afterMs: NOW,
    scheduleSettings: { matchupDuration: 1, playoffTeams: 4, playoffDuration: 1 } });
  check(p.ok, "6 teams: plan succeeds");
  // Future active weeks: 3..16 minus off week 6 = 13. 4-team playoff = 2 rounds = 2 weeks.
  check(JSON.stringify(p.regularWeeks) === JSON.stringify([3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14]),
    `regular season skips started weeks and the off week: ${p.regularWeeks.join(",")}`);
  check(JSON.stringify(p.playoffWeeks) === JSON.stringify([15, 16]), `last 2 weeks reserved for playoffs: ${p.playoffWeeks.join(",")}`);
  check(p.matchups.length === 11 * 3, `3 matchups each regular week (${p.matchups.length})`);
  check(weekBookingOk(p.matchups), "no team plays twice in a week");
  const firstCycle = new Set(p.matchups.filter(m => p.regularWeeks.indexOf(m.week) < 5)
    .map(m => [m.homeTeamId, m.awayTeamId].sort().join("-")));
  check(firstCycle.size === 15, `every pair meets in the first 5 weeks (${firstCycle.size}/15)`);

  const five = planSchedule({ teamIds: ["a", "b", "c", "d", "e"], seasonWeeks: weeks, afterMs: NOW,
    scheduleSettings: { playoffTeams: 4 } });
  const perWeek = five.matchups.filter(m => m.week === five.regularWeeks[0]).length;
  check(five.ok && perWeek === 2, `5 teams: 2 matchups a week, one team on bye (${perWeek})`);

  const two = planSchedule({ teamIds: six, seasonWeeks: weeks, afterMs: NOW,
    scheduleSettings: { matchupDuration: 2, playoffTeams: 4 } });
  const opp = (plan, wk) => plan.matchups.filter(m => m.week === wk).map(m => [m.homeTeamId, m.awayTeamId].sort().join("-")).sort().join("|");
  check(opp(two, 3) === opp(two, 4) && opp(two, 4) !== opp(two, 5), "2-week matchups keep the same pairs for 2 weeks");

  const late = planSchedule({ teamIds: six, seasonWeeks: weeks, afterMs: NOW + 80 * DAY, // only weeks 14-16 left; a 6-team bracket needs all 3
    scheduleSettings: { playoffTeams: 8 } });
  check(!late.ok && /playoffs/.test(late.reason), `too few weeks left → clear error, no schedule ("${late.reason}")`);

  check(buildRoundRobin(["x"]).every(r => r.length === 0) && !planSchedule({ teamIds: ["x"], seasonWeeks: weeks, afterMs: NOW }).ok,
    "1 team → no pairings and no schedule");
}

async function waitFor(fn, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

async function part2() {
  console.log("\nPART 2 — trigger on the emulator");
  const SEASON = "test_sched_season";
  const created = [];
  const leagueRef = adminDb.collection("fantasy_leagues").doc("test_sched_league");
  const noWeeksLeague = adminDb.collection("fantasy_leagues").doc("test_sched_noweeks");
  try {
    const seasonRef = adminDb.collection("pwhl_seasons").doc(SEASON);
    await seasonRef.set({ weeks: makeWeeks(), isTestNode: true }); created.push(seasonRef);

    for (const [ref, season] of [[leagueRef, SEASON], [noWeeksLeague, "test_sched_missing"]]) {
      await ref.set({
        name: "Schedule Test", season_id: season, status: "drafting", currentWeek: 1, isTestNode: true,
        scheduleSettings: { matchupDuration: 1, playoffTeams: 4, playoffDuration: 1 },
      });
      created.push(ref);
      for (let i = 1; i <= 6; i++) {
        const t = ref.collection("teams").doc(`team_${i}`);
        await t.set({ teamName: `Team ${i}`, ownerId: `owner_${i}`, players: [], isTestNode: true });
        created.push(t);
      }
    }

    // A completed draft. The draft engine ignores non-active drafts, so no picks run.
    await leagueRef.collection("draft").doc("state").set({ status: "completed", isTestNode: true, completedAt: Timestamp.now() });
    created.push(leagueRef.collection("draft").doc("state"));

    const snap = await waitFor(async () => {
      const s = await leagueRef.collection("matchups").get();
      return s.size > 0 ? s : null;
    });
    check(Boolean(snap), "draft completion writes matchup documents");
    if (snap) {
      // Give the batch a moment to finish, then re-read.
      await new Promise(r => setTimeout(r, 1500));
      const all = (await leagueRef.collection("matchups").get()).docs;
      all.forEach(d => created.push(d.ref));
      const ms = all.map(d => d.data());
      check(all.length === 33, `33 matchups (11 weeks × 3): got ${all.length}`);
      check(weekBookingOk(ms), "no team plays twice in a week");
      check(ms.every(m => m.status === "pending" && m.homeTeamName && m.awayTeamName), "matchups are pending and carry team names");
      check(all.every(d => /^week_\d+_matchup_\d+$/.test(d.id)), "document ids use week_{W}_matchup_{i}");
      const league = (await leagueRef.get()).data();
      check(league.currentWeek === 3, `league currentWeek moves to the first scheduled week (3): got ${league.currentWeek}`);
      check(JSON.stringify(league.schedule?.playoffWeeks) === "[15,16]", `league records reserved playoff weeks: ${JSON.stringify(league.schedule?.playoffWeeks)}`);

      // Another write to the completed draft must not create a second schedule.
      await leagueRef.collection("draft").doc("state").set({ touchedAgain: true }, { merge: true });
      await new Promise(r => setTimeout(r, 4000));
      const again = await leagueRef.collection("matchups").get();
      check(again.size === 33, `a second draft write leaves the schedule unchanged (${again.size})`);
    }

    // League whose season has no week map: no schedule, no crash.
    await noWeeksLeague.collection("draft").doc("state").set({ status: "completed", isTestNode: true });
    created.push(noWeeksLeague.collection("draft").doc("state"));
    await new Promise(r => setTimeout(r, 4000));
    const none = await noWeeksLeague.collection("matchups").get();
    check(none.size === 0, "season without weeks → no matchups written (error logged instead)");
  } finally {
    for (const ref of created.reverse()) { try { await ref.delete(); } catch { /* fine */ } }
  }
}

part1();
await part2();
console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
