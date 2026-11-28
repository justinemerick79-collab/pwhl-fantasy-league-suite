/**
 * test-season-weeks.js
 *
 * The season week map (pwhl_seasons/{id}.weeks) is now built by the daily
 * server sync (functions/seasonWeeks.js). This checks:
 *   1. week boundaries and game placement on known tricky dates
 *   2. the server builder and the client's generateWeeksList() agree, on a
 *      fixture and on the live 2026-27 feed
 *   3. running the real syncDailyData handler writes the season document and
 *      its week map (live feed in, Firestore EMULATOR out)
 *
 *   firebase emulators:exec --only functions,firestore,auth "npx tsx test-season-weeks.js"
 */
import { createRequire } from "module";
import { requireEmulator, createAdminFixtures } from "./test-support.js";

requireEmulator("test-season-weeks.js");
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || "pwhl-fantasy-mobile-26";

const require = createRequire(import.meta.url);
const { buildSeasonWeeks } = require("./functions/seasonWeeks.js");
const { generateWeeksList } = await import("./src/services/pwhlService.js");
const { adminDb } = createAdminFixtures("pwhl-fantasy-mobile-26", "test-season-weeks");

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "✅" : "❌"} ${label}`);
  if (!ok) failures++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const g = (id, date) => ({ game_id: id, date_played: date });

function part1() {
  console.log("\nPART 1 — boundaries and placement");
  const games = [
    g(1, "2026-12-05"),            // Saturday, week 1
    g(2, "2026-12-07"),            // MONDAY → must be week 2, not week 1
    g(3, "2026-12-13"),            // Sunday → still week 2
    g(4, "2027-03-15"),            // Monday after the switch to daylight time
  ];
  const w = buildSeasonWeeks("2026-12-04", "2027-04-19", games);
  check(w[0].start === "2026-11-30T08:00:00.000Z", `week 1 starts Monday 00:00 Pacific (${w[0].start})`);
  check(w[0].end === "2026-12-07T07:59:59.999Z", `week 1 ends Sunday 23:59:59.999 Pacific (${w[0].end})`);
  check(same(w[0].games, ["1"]), `week 1 holds only the Saturday game (${w[0].games})`);
  check(same(w[1].games, ["2", "3"]), `the Monday game is in week 2 with the Sunday game (${w[1].games})`);
  const dst = w.find(x => x.games.includes("4"));
  check(dst && dst.start === "2027-03-15T07:00:00.000Z", `daylight-time week starts at 07:00 UTC (${dst && dst.start})`);
  check(w[2].isOffWeek && w[2].gameCount === 0, "a week with no games is an off week");
  check(buildSeasonWeeks(undefined, "2027-04-19", games).length === 0, "missing start date → no weeks (no guessing)");
  check(same(w, generateWeeksList("2026-12-04", "2027-04-19", games)), "server and client builders agree on the fixture");
}

async function part2() {
  console.log("\nPART 2 — live 2026-27 feed");
  const url = "https://lscluster.hockeytech.com/feed/index.php?feed=modulekit&view=schedule&season_id=11&key=446521baf8c38984&client_code=pwhl&fmt=json";
  const text = (await (await fetch(url)).text()).replace(/^\(|\)$/g, "");
  const games = JSON.parse(text).SiteKit.Schedule;
  const server = buildSeasonWeeks("2026-12-04", "2027-04-19", games);
  const placed = server.reduce((n, w) => n + w.gameCount, 0);
  check(placed === games.length, `every game lands in exactly one week (${placed}/${games.length})`);
  check(same(server, generateWeeksList("2026-12-04", "2027-04-19", games)), "server and client builders agree on the live feed");
}

async function part3() {
  console.log("\nPART 3 — real syncDailyData handler (writes to the emulator only)");
  const fns = require("./functions/index.js");
  try {
    await fns.syncDailyData.run({});
    await assertSeason();
  } finally {
    // Remove everything the sync wrote, so later tests start from the empty
    // database they expect. Emulator only (requireEmulator above).
    for (const c of ["pwhl_seasons", "pwhl_games", "pwhl_player_stats", "pwhl_season_player_stats", "daily_game_stats"]) {
      await adminDb.recursiveDelete(adminDb.collection(c));
    }
  }
}

async function assertSeason() {
  const snap = await adminDb.collection("pwhl_seasons").doc("11").get();
  check(snap.exists, "pwhl_seasons/11 exists after the sync");
  const d = snap.data() || {};
  check(d.season_name === "2026-27 Regular Season" && d.playoff === "0" && d.career === "1",
    `season fields come from the feed (${d.season_name}, playoff=${d.playoff}, career=${d.career})`);
  const weeks = d.weeks || [];
  const placed = weeks.reduce((n, w) => n + w.gameCount, 0);
  check(weeks.length >= 20 && placed >= 180, `week map written: ${weeks.length} weeks, ${placed} games placed`);
  check(weeks[0] && weeks[0].start === "2026-11-30T08:00:00.000Z", `week 1 starts Monday 2026-11-30 Pacific (${weeks[0] && weeks[0].start})`);
}

part1();
await part2();
await part3();
console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
