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
