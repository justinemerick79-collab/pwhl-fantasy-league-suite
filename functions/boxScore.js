/**
 * One parser and one scoring formula for every game-stats path: live polling,
 * post-game checks, the nightly official switch, settlement and the simulation.
 *
 * normalizeBoxScore(summary) turns a LeagueStat `GC.Gamesummary` into
 *   { skaters: { pid: { name, team, pos, goals, assists, plusMinus, ppp, shp, sog, hits, blocks, pim } },
 *     goalies: { pid: { name, team, saves, goalsAgainst, shotsAgainst, timeOnIce, wins, losses, overtimeLosses, shutouts } } }
 *
 * Rules (unchanged from the original calculatePlayerStatsFromSummary):
 *  - Assists, and the power-play / short-handed points, come from `goals[]`.
 *  - Shots on goal = `shots_on`, else `shots`. Blocks = `shots_blocked_by_player`.
 *  - Goalie decisions (W / L / OTL / SO) count only when the game is final: a
 *    preseason game can show a practice overtime or shootout before Final.
 */

const STAT_KEYS_SKATER = ["goals", "assists", "plusMinus", "ppp", "shp", "sog", "hits", "blocks", "pim"];
const STAT_KEYS_GOALIE = ["saves", "goalsAgainst", "shotsAgainst", "timeOnIce", "wins", "losses", "overtimeLosses", "shutouts"];

const DEFAULT_SCORING = {
  skaters: { goals: 2, assists: 1, plusMinus: 0.5, ppp: 0.5, shp: 0.5, sog: 0.1, hits: 0.1, blocks: 0.5, defensePoints: 0.5 },
  goalies: { wins: 4, otl: 1, ga: -2, saves: 0.2, shutouts: 3 }
};

const int = (v) => parseInt(v || 0, 10) || 0;
const round2 = (n) => Math.round(n * 100) / 100;

function normalizePosition(posStr) {
  if (!posStr) return "F";
  const up = String(posStr).toUpperCase().trim();
  if (["D", "RD", "LD", "DEFENSE", "DEFENSEMAN", "DEFENSEMEN"].includes(up)) return "D";
  if (["G", "GOALIE", "GOALTENDER", "GOALIES"].includes(up)) return "G";
  return "F";
}

function nameOf(p) {
  return `${p.first_name || ""} ${p.last_name || ""}`.trim() || p.name || "";
}

/**
 * @param {object} summary  LeagueStat GC.Gamesummary
 * @param {{final?: boolean}} [opts]  final=false zeroes goalie decisions
 */
function normalizeBoxScore(summary, { final = true } = {}) {
  const s = summary || {};
  const assists = {};
  const specialGoals = {};
  for (const goal of Array.isArray(s.goals) ? s.goals : []) {
    const pp = goal.power_play === "1" || goal.power_play === 1;
    const sh = goal.short_handed === "1" || goal.short_handed === 1;
    const scorer = goal.goal_scorer?.player_id;
    if (scorer) {
      const g = (specialGoals[String(scorer)] ||= { pp: 0, sh: 0 });
      if (pp) g.pp++;
      if (sh) g.sh++;
    }
    for (const a of [goal.assist1_player, goal.assist2_player]) {
      if (!a?.player_id) continue;
      const r = (assists[String(a.player_id)] ||= { n: 0, pp: 0, sh: 0 });
      r.n++;
      if (pp) r.pp++;
      if (sh) r.sh++;
    }
  }

  const skaters = {};
  for (const [side, key] of [["home", "home_team_lineup"], ["visitor", "visitor_team_lineup"]]) {
    for (const p of s[key]?.players || []) {
      const id = String(p.player_id || "");
      if (!id) continue;
      const a = assists[id] || { n: 0, pp: 0, sh: 0 };
      const g = specialGoals[id] || { pp: 0, sh: 0 };
      const pm = p.plusminus;
      skaters[id] = {
        name: nameOf(p), team: side, pos: normalizePosition(p.position_str || p.position),
        goals: int(p.goals),
        assists: a.n,
        plusMinus: pm !== undefined && pm !== null && pm !== "" ? (parseInt(pm, 10) || 0) : 0,
        ppp: a.pp + g.pp,
        shp: a.sh + g.sh,
        sog: int(p.shots_on || p.shots),
        hits: int(p.hits),
        blocks: int(p.shots_blocked_by_player || p.shots_blocked),
        pim: int(p.pim),
      };
    }
  }

  const goalies = {};
  for (const side of ["home", "visitor"]) {
    for (const gk of s.goalies?.[side] || []) {
      const id = String(gk.player_id || "");
      if (!id) continue;
      let secs = int(gk.seconds || gk.secs);
      if (!secs && typeof gk.secs_mmss === "string" && gk.secs_mmss.includes(":")) {
        const [m, sec] = gk.secs_mmss.split(":").map(Number);
        secs = m * 60 + sec;
      }
      const row = {
        name: nameOf(gk), team: side,
        saves: int(gk.saves), goalsAgainst: int(gk.goals_against), shotsAgainst: int(gk.shots_against), timeOnIce: secs,
        wins: final ? int(gk.win) : 0, losses: final ? int(gk.loss) : 0,
        overtimeLosses: final ? int(gk.ot_loss) : 0, shutouts: final ? int(gk.shutout) : 0,
      };
      const prev = goalies[id];
      if (!prev) goalies[id] = row;
      else {
        prev.saves += row.saves; prev.goalsAgainst += row.goalsAgainst; prev.shotsAgainst += row.shotsAgainst;
        prev.timeOnIce += row.timeOnIce;
        for (const k of ["wins", "losses", "overtimeLosses", "shutouts"]) prev[k] = Math.max(prev[k], row[k]);
      }
    }
  }
  return { skaters, goalies };
}

/** Fantasy points for one skater stat line. */
function scoreSkater(st, matrix, pos) {
  const m = matrix || DEFAULT_SCORING.skaters;
  let pts = st.goals * (m.goals || 0) + st.assists * (m.assists || 0) + st.plusMinus * (m.plusMinus || 0)
    + st.ppp * (m.ppp || 0) + st.shp * (m.shp || 0) + st.sog * (m.sog || 0) + st.hits * (m.hits || 0)
    + st.blocks * (m.blocks || 0);
  if (pos === "D") pts += (st.goals + st.assists) * (m.defensePoints || 0);
  return pts;
}

/** Fantasy points for one goalie stat line; a goalie who did not play scores nothing. */
function scoreGoalie(st, matrix) {
  if (!(st.timeOnIce > 0 || st.saves > 0 || st.goalsAgainst > 0)) return null;
  const m = matrix || DEFAULT_SCORING.goalies;
  return st.wins * (m.wins || 0) + st.overtimeLosses * (m.otl || 0) + st.goalsAgainst * (m.ga || 0)
    + st.saves * (m.saves || 0) + st.shutouts * (m.shutouts || 0);
}

/**
 * Points per player for one game's box score.
 * @param {object} box     normalizeBoxScore output
 * @param {object} scoring { skaters, goalies } matrix
 * @param {object} [posOverride] pid → 'F'|'D'|'G'; when given, used instead of the box position (default 'F')
 * @returns {Record<string, number>} pid → points, rounded to 2 places
 */
function pointsForGame(box, scoring, posOverride) {
  const out = {};
  for (const [pid, st] of Object.entries(box.skaters || {})) {
    const pos = posOverride ? (posOverride[pid] || "F") : st.pos;
    out[pid] = (out[pid] || 0) + scoreSkater(st, scoring?.skaters, pos);
  }
  for (const [pid, st] of Object.entries(box.goalies || {})) {
    const pts = scoreGoalie(st, scoring?.goalies);
    if (pts !== null) out[pid] = (out[pid] || 0) + pts;
  }
  for (const pid of Object.keys(out)) out[pid] = round2(out[pid]);
  return out;
}

/** Stable hash of a box score's stats (names excluded), for change detection. */
function boxHash(box) {
  const crypto = require("crypto");
  const pick = (rows, keys) => Object.keys(rows || {}).sort().map(id => [id, ...keys.map(k => rows[id][k])]);
  return crypto.createHash("sha1").update(JSON.stringify([pick(box.skaters, STAT_KEYS_SKATER), pick(box.goalies, STAT_KEYS_GOALIE)])).digest("hex");
}

/**
 * Per-player stat changes between two box scores.
 * @returns {Array<{playerId, name, team, changes: Array<{stat, from, to}>}>}
 */
function diffBoxScores(before, after) {
  const out = [];
  for (const [kind, keys] of [["skaters", STAT_KEYS_SKATER], ["goalies", STAT_KEYS_GOALIE.filter(k => k !== "timeOnIce")]]) {
    const ids = new Set([...Object.keys(before?.[kind] || {}), ...Object.keys(after?.[kind] || {})]);
    for (const id of ids) {
      const a = before?.[kind]?.[id] || {};
      const b = after?.[kind]?.[id] || {};
      const changes = keys.filter(k => (a[k] || 0) !== (b[k] || 0)).map(k => ({ stat: k, from: a[k] || 0, to: b[k] || 0 }));
      if (changes.length) out.push({ playerId: id, name: b.name || a.name || "", team: b.team || a.team || "", kind, changes });
    }
  }
  return out;
}

module.exports = {
  normalizeBoxScore, scoreSkater, scoreGoalie, pointsForGame, boxHash, diffBoxScores,
  normalizePosition, DEFAULT_SCORING, STAT_KEYS_SKATER, STAT_KEYS_GOALIE, round2,
};
