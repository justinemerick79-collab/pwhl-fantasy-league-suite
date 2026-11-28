/**
 * Season week map: pwhl_seasons/{id}.weeks.
 *
 * Fantasy weeks run Monday 00:00 to Sunday 23:59:59.999 **Pacific time**, the
 * same clock league days use (getPSTDateStr). Week 1 is the week that contains
 * the season's start_date. A week with no PWHL games is an off week.
 *
 * Games are assigned by calendar date (the feed's `date_played`, YYYY-MM-DD),
 * compared as date strings. Parsing a bare date with `new Date()` gives midnight
 * UTC — 4 pm the previous day in Pacific time — which moved every Monday game
 * into the week before. Comparing strings avoids any time-zone conversion.
 *
 * The client's generateWeeksList() in src/services/pwhlService.js must produce
 * the same result. Keep the two in step.
 */
const TZ = "America/Los_Angeles";

const hourIn = (() => {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" });
  return (ms) => Number(fmt.format(new Date(ms)));
})();

/** UTC milliseconds of 00:00 Pacific on a YYYY-MM-DD date (handles PST and PDT). */
function pacificMidnightMs(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  for (const offsetHours of [8, 7]) {
    const ms = Date.UTC(y, m - 1, d, offsetHours);
    if (hourIn(ms) === 0) return ms;
  }
  throw new Error(`Cannot resolve Pacific midnight for ${dateStr}`);
}

/** YYYY-MM-DD plus n days (calendar arithmetic, no time zone). */
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The Monday on or before a YYYY-MM-DD date. */
function mondayOf(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDays(dateStr, dow === 0 ? -6 : 1 - dow);
}

/** A game's calendar date as YYYY-MM-DD, or null. */
function gameDate(game) {
  const raw = game.date_played || game.GameDateISO8601 || game.date || "";
  return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null;
}

const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s);

/**
 * @param {string} seasonStart YYYY-MM-DD (time part ignored)
 * @param {string} seasonEnd   YYYY-MM-DD (time part ignored)
 * @param {object[]} games     feed schedule rows
 * @returns {Array<{week:number,start:string,end:string,gameCount:number,isOffWeek:boolean,games:string[]}>}
 */
function buildSeasonWeeks(seasonStart, seasonEnd, games = []) {
  if (!isDate(seasonStart) || !isDate(seasonEnd)) return [];
  const startDay = seasonStart.slice(0, 10);
  const endDay = seasonEnd.slice(0, 10);

  const weeks = [];
  for (let monday = mondayOf(startDay), n = 1; monday <= endDay; monday = addDays(monday, 7), n++) {
    const sunday = addDays(monday, 6);
    const inWeek = games.filter(g => {
      const d = gameDate(g);
      return d && d >= monday && d <= sunday;
    });
    weeks.push({
      week: n,
      start: new Date(pacificMidnightMs(monday)).toISOString(),
      end: new Date(pacificMidnightMs(addDays(monday, 7)) - 1).toISOString(),
      gameCount: inWeek.length,
      isOffWeek: inWeek.length === 0,
      games: inWeek.map(g => String(g.game_id || g.id))
    });
  }
  return weeks;
}

module.exports = { buildSeasonWeeks, pacificMidnightMs, mondayOf, addDays, gameDate };
