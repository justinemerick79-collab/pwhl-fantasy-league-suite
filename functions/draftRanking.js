/**
 * Draft value: how the bot engine and auto-pick rank players.
 *
 * Value = projected fantasy points for the league's season under the LEAGUE's scoring.
 * Data, best first:
 *   1. projection   pwhl_projections/{S}/player_projections/{pid}.projected_season_stats
 *   2. last_season  the player's totals in the previous regular season (pwhl_player_stats)
 *   3. none         value 0 (e.g. a rookie before projections are generated)
 *
 * Before this, both rankers read a `stats` field that real player docs do not have, so
 * every player scored 0: bots drafted alphabetically and timed-out picks were arbitrary.
 * The browser copy is src/services/scoring.js#projectedPoints (keep the two in step;
 * test-draft-rankings.js checks they agree).
 */
const DEFAULT_SCORING = {
  skaters: { goals: 2, assists: 1, plusMinus: 0.5, ppp: 0.5, shp: 0.5, sog: 0.1, hits: 0.1, blocks: 0.5, defensePoints: 0.5 },
  goalies: { wins: 4, otl: 1, ga: -2, saves: 0.2, shutouts: 3 },
};
const n = (v) => Number(v) || 0;

/** A projection's season stats → the common line. */
function fromProjection(ps = {}) {
  return {
    goals: n(ps.goals), assists: n(ps.assists), plusMinus: n(ps.plusMinus), ppp: n(ps.powerPlayPoints),
    shp: n(ps.shortHandedPoints), sog: n(ps.shotsOnGoal), hits: n(ps.hits), blocks: n(ps.blockedShots),
    wins: n(ps.wins), otl: n(ps.overtimeLosses ?? ps.otl), ga: n(ps.goalsAgainst ?? ps.ga),
    saves: n(ps.shotsSaved ?? ps.saves), shutouts: n(ps.shutouts),
  };
}

/** A feed season stat row (statviewtype topscorers/topgoalies) → the common line. */
function fromSeasonStats(r = {}) {
  return {
    goals: n(r.goals), assists: n(r.assists), plusMinus: n(r.plus_minus), ppp: n(r.power_play_points),
    shp: n(r.short_handed_points), sog: n(r.shots), hits: n(r.hits), blocks: n(r.shots_blocked_by_player),
    wins: n(r.wins), otl: n(r.ot_losses), ga: n(r.goals_against), saves: n(r.saves), shutouts: n(r.shutouts),
  };
}

/** Fantasy points of a common line under a scoring matrix. */
function projectedPoints(line, scoring, pos) {
  if (!line) return 0;
  if (pos === "G") {
    const m = scoring?.goalies || DEFAULT_SCORING.goalies;
    return line.wins * (m.wins || 0) + line.otl * (m.otl || 0) + line.ga * (m.ga || 0) + line.saves * (m.saves || 0) + line.shutouts * (m.shutouts || 0);
  }
  const m = scoring?.skaters || DEFAULT_SCORING.skaters;
  let pts = line.goals * (m.goals || 0) + line.assists * (m.assists || 0) + line.plusMinus * (m.plusMinus || 0)
    + line.ppp * (m.ppp || 0) + line.shp * (m.shp || 0) + line.sog * (m.sog || 0) + line.hits * (m.hits || 0) + line.blocks * (m.blocks || 0);
  if (pos === "D") pts += (line.goals + line.assists) * (m.defensePoints || 0);
  return pts;
}

/** The previous regular season before S (career 1, playoff 0, starting earlier), or null. */
async function previousRegularSeasonId(db, seasonId) {
  const all = (await db.collection("pwhl_seasons").get()).docs.map(d => d.data());
  const target = all.find(s => String(s.season_id) === String(seasonId));
  const start = Date.parse(target?.start_date);
  if (Number.isNaN(start)) return null;
  const prev = all
    .filter(s => String(s.career) === "1" && String(s.playoff) === "0" && Date.parse(s.start_date) < start)
    .sort((a, b) => Date.parse(b.start_date) - Date.parse(a.start_date))[0];
  return prev ? String(prev.season_id) : null;
}

/**
 * Rank lines for a season: Map pid → { line, source }.
 */
async function loadRankLines(db, seasonId) {
  const S = String(seasonId);
  const out = new Map();
  const proj = await db.collection("pwhl_projections").doc(S).collection("player_projections").get();
  proj.forEach(d => out.set(String(d.data().playerId || d.id), { line: fromProjection(d.data().projected_season_stats), source: "projection" }));
  const prev = await previousRegularSeasonId(db, S);
  if (prev) {
    const stats = await db.collection("pwhl_player_stats").where("season_id", "in", [prev, Number(prev)]).get();
    stats.forEach(d => {
      const pid = String(d.data().player_id);
      if (!out.has(pid)) out.set(pid, { line: fromSeasonStats(d.data()), source: "last_season" });
    });
  }
  return out;
}

module.exports = { loadRankLines, projectedPoints, fromProjection, fromSeasonStats, previousRegularSeasonId, DEFAULT_SCORING };
