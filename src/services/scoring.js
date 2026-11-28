/**
 * Client copy of the server scoring formula (functions/boxScore.js scoreSkater /
 * scoreGoalie), for showing the fantasy-point effect of a stat correction under a
 * league's scoring. test-live-scoring.js checks the two give the same results.
 */
const DEFAULT_SKATERS = { goals: 2, assists: 1, plusMinus: 0.5, ppp: 0.5, shp: 0.5, sog: 0.1, hits: 0.1, blocks: 0.5, defensePoints: 0.5 };
const DEFAULT_GOALIES = { wins: 4, otl: 1, ga: -2, saves: 0.2, shutouts: 3 };

// Stat key in a box score → key in the league scoring matrix.
const GOALIE_MATRIX_KEY = { wins: 'wins', overtimeLosses: 'otl', goalsAgainst: 'ga', saves: 'saves', shutouts: 'shutouts' };

/**
 * Fantasy-point change caused by a list of stat changes.
 * @param {Array<{stat, from, to}>} changes
 * @param {'skaters'|'goalies'} kind
 * @param {object} scoringSettings league.scoringSettings ({ skaters, goalies })
 * @param {string} [pos] 'F' | 'D' | 'G' (the defense bonus needs 'D')
 */
export function pointsDelta(changes, kind, scoringSettings, pos) {
  let delta = 0;
  if (kind === 'goalies') {
    const m = scoringSettings?.goalies || DEFAULT_GOALIES;
    for (const c of changes) {
      const key = GOALIE_MATRIX_KEY[c.stat];
      if (key) delta += (c.to - c.from) * (m[key] || 0);
    }
  } else {
    const m = scoringSettings?.skaters || DEFAULT_SKATERS;
    for (const c of changes) {
      delta += (c.to - c.from) * (m[c.stat] || 0);
      if (pos === 'D' && (c.stat === 'goals' || c.stat === 'assists')) delta += (c.to - c.from) * (m.defensePoints || 0);
    }
  }
  return Math.round(delta * 100) / 100;
}

export const STAT_LABELS = {
  goals: 'G', assists: 'A', plusMinus: '+/-', ppp: 'PPP', shp: 'SHP', sog: 'SOG', hits: 'Hits', blocks: 'Blk', pim: 'PIM',
  saves: 'Saves', goalsAgainst: 'GA', shotsAgainst: 'SA', wins: 'W', losses: 'L', overtimeLosses: 'OTL', shutouts: 'SO',
};

// ── Draft value (browser copy of functions/draftRanking.js — keep in step) ──
const n = (v) => Number(v) || 0;

/** A projection's season stats → the common rank line. */
export function rankLineFromProjection(ps = {}) {
  return {
    goals: n(ps.goals), assists: n(ps.assists), plusMinus: n(ps.plusMinus), ppp: n(ps.powerPlayPoints),
    shp: n(ps.shortHandedPoints), sog: n(ps.shotsOnGoal), hits: n(ps.hits), blocks: n(ps.blockedShots),
    wins: n(ps.wins), otl: n(ps.overtimeLosses ?? ps.otl), ga: n(ps.goalsAgainst ?? ps.ga),
    saves: n(ps.shotsSaved ?? ps.saves), shutouts: n(ps.shutouts),
  };
}

/** A feed season stat row (pwhl_player_stats) → the common rank line. */
export function rankLineFromSeasonStats(r = {}) {
  return {
    goals: n(r.goals), assists: n(r.assists), plusMinus: n(r.plus_minus), ppp: n(r.power_play_points),
    shp: n(r.short_handed_points), sog: n(r.shots), hits: n(r.hits), blocks: n(r.shots_blocked_by_player),
    wins: n(r.wins), otl: n(r.ot_losses), ga: n(r.goals_against), saves: n(r.saves), shutouts: n(r.shutouts),
  };
}

/** Projected fantasy points of a rank line under a league's scoring. */
export function projectedPoints(line, scoringSettings, pos) {
  if (!line) return 0;
  if (pos === 'G') {
    const m = scoringSettings?.goalies || DEFAULT_GOALIES;
    return line.wins * (m.wins || 0) + line.otl * (m.otl || 0) + line.ga * (m.ga || 0) + line.saves * (m.saves || 0) + line.shutouts * (m.shutouts || 0);
  }
  const m = scoringSettings?.skaters || DEFAULT_SKATERS;
  let pts = line.goals * (m.goals || 0) + line.assists * (m.assists || 0) + line.plusMinus * (m.plusMinus || 0)
    + line.ppp * (m.ppp || 0) + line.shp * (m.shp || 0) + line.sog * (m.sog || 0) + line.hits * (m.hits || 0) + line.blocks * (m.blocks || 0);
  if (pos === 'D') pts += (line.goals + line.assists) * (m.defensePoints || 0);
  return pts;
}
