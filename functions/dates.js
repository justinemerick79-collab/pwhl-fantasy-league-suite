/**
 * Pacific-time date helpers for the server. League days are PST/PDT-based (see
 * getPSTDateStr in src/services/leagueService.js); Cloud Functions run in UTC, so
 * never use getFullYear()/getDate() on a server Date for a game day.
 */
const { pacificMidnightMs, addDays } = require("./seasonWeeks");

const PACIFIC_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" });

/** "YYYY-MM-DD" of the Pacific calendar day containing `ms` (default: now). */
function pacificDateStr(ms = Date.now()) {
  return PACIFIC_DATE.format(new Date(ms));
}

module.exports = { pacificDateStr, pacificMidnightMs, addDays };
