/**
 * Playoffs: seeding, bracket and advancement.
 *
 * The regular-season schedule (schedule.js) reserves the last game weeks of the
 * season in `league.schedule.playoffWeeks`. When the last regular-season week
 * settles, the top `scheduleSettings.playoffTeams` teams are seeded and round 1
 * is written; each time a round's last week settles, the winners advance; after
 * the final the league records its champion in `league.playoffs`.
 *
 * Rules:
 *  - Seeding: win percentage (a tie counts half a win), then points for, then team id.
 *  - Byes: a bracket that is not a power of two gives the top seeds a first-round bye
 *    (6 teams → seeds 1 and 2).
 *  - Pairing: every round, the best remaining seed plays the worst remaining seed.
 *  - A playoff matchup does not change regular-season records. A tied playoff
 *    matchup goes to the higher seed.
 *  - Each round lasts `scheduleSettings.playoffDuration` weeks (default 1). The
 *    matchup is stored under the round's LAST week and scored over the whole round.
 */
const { Timestamp } = require("firebase-admin/firestore");

function roundCount(n) {
  return n >= 2 ? Math.ceil(Math.log2(n)) : 0;
}

/** Team ids in seed order (best first). */
function seedTeams(teams) {
  const pct = (t) => {
    const g = (t.wins || 0) + (t.losses || 0) + (t.ties || 0);
    return g === 0 ? 0 : ((t.wins || 0) + 0.5 * (t.ties || 0)) / g;
  };
  return [...teams]
    .sort((a, b) => pct(b) - pct(a) || (b.points || 0) - (a.points || 0) || String(a.id).localeCompare(String(b.id)))
    .map(t => t.id);
}

/**
 * Pairings for one round.
 * @param {string[]} alive   team ids still in, any order
 * @param {Record<string,number>} seedOf  team id → seed (1 = best)
 * @param {number} byes      teams to skip this round (round 1 only)
 * @returns {{pairs: Array<[string,string]>, byes: string[]}} pairs are [higher seed, lower seed]
 */
function pairRound(alive, seedOf, byes = 0) {
  const ordered = [...alive].sort((a, b) => seedOf[a] - seedOf[b]);
  const byeTeams = ordered.slice(0, byes);
  const playing = ordered.slice(byes);
  const pairs = [];
  for (let i = 0; i < playing.length / 2; i++) pairs.push([playing[i], playing[playing.length - 1 - i]]);
  return { pairs, byes: byeTeams };
}

/** The weeks of round r (1-based). */
function roundWeeks(playoffWeeks, r, duration) {
  return playoffWeeks.slice((r - 1) * duration, r * duration);
}

function settings(league) {
  const s = league.scheduleSettings || {};
  return { teams: Number(s.playoffTeams) || 0, duration: Math.max(1, Number(s.playoffDuration) || 1) };
}

/**
 * Called after any week settles. Starts the playoffs after the last regular-season
 * week, and advances them after the last week of each round. Safe to call twice:
 * every step checks the league's recorded playoff state first.
 *
 * @returns {Promise<string>} what happened
 */
async function afterWeekSettled(db, leagueId, weekNum) {
  const leagueRef = db.collection("fantasy_leagues").doc(leagueId);
  return db.runTransaction(async (tx) => {
    const leagueSnap = await tx.get(leagueRef);
    if (!leagueSnap.exists) return "no league";
    const league = leagueSnap.data();
    const seasonSnap = league.season_id != null ? await tx.get(db.collection("pwhl_seasons").doc(String(league.season_id))) : null;
    const seasonWeeks = seasonSnap && seasonSnap.exists ? (seasonSnap.data().weeks || []) : [];
    const regular = league.schedule?.regularSeasonWeeks || [];
    const playoffWeeks = league.schedule?.playoffWeeks || [];
    const { teams: playoffTeams, duration } = settings(league);
    const weekStart = (w) => (seasonWeeks || []).find(x => x.week === w)?.start || null;
    const nameOf = {};

    const writeRound = (r, pairs, seedOf) => {
      const weeks = roundWeeks(playoffWeeks, r, duration);
      const week = weeks[weeks.length - 1];
      pairs.forEach(([high, low], i) => {
        tx.set(leagueRef.collection("matchups").doc(`week_${week}_playoff_${r}_${i + 1}`), {
          week, isPlayoff: true, round: r, roundWeeks: weeks, roundStart: weekStart(weeks[0]),
          homeTeamId: high, awayTeamId: low, homeSeed: seedOf[high], awaySeed: seedOf[low],
          homeTeamName: nameOf[high] || "Team", awayTeamName: nameOf[low] || "Team",
          homeScore: 0, awayScore: 0, status: "pending", createdAt: Timestamp.now()
        });
      });
    };

    // ── Start: the last regular-season week just settled ──
    if (!league.playoffs && regular.length && weekNum === regular[regular.length - 1]) {
      const teamsSnap = await tx.get(leagueRef.collection("teams"));
      const teams = teamsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      teams.forEach(t => { nameOf[t.id] = t.teamName; });
      const n = Math.min(playoffTeams, teams.length);
      const rounds = roundCount(n);
      if (rounds === 0 || playoffWeeks.length < rounds * duration) {
        tx.update(leagueRef, { playoffs: { status: "none", reason: rounds === 0 ? "fewer than 2 playoff teams" : "not enough playoff weeks" } });
        return "no playoffs";
      }
      const seeds = seedTeams(teams).slice(0, n);
      const seedOf = Object.fromEntries(seeds.map((id, i) => [id, i + 1]));
      const { pairs, byes } = pairRound(seeds, seedOf, 2 ** rounds - n);
      writeRound(1, pairs, seedOf);
      tx.update(leagueRef, { playoffs: { status: "in_progress", seeds, round: 1, totalRounds: rounds, alive: seeds, byes } });
      return `started: ${n} teams, ${rounds} rounds`;
    }

    // ── Advance: the last week of the current round just settled ──
    const p = league.playoffs;
    if (!p || p.status !== "in_progress") return "nothing to do";
    const weeks = roundWeeks(playoffWeeks, p.round, duration);
    if (weekNum !== weeks[weeks.length - 1]) return "mid-round";

    const roundSnap = await tx.get(leagueRef.collection("matchups").where("week", "==", weekNum).where("isPlayoff", "==", true));
    const seedOf = Object.fromEntries(p.seeds.map((id, i) => [id, i + 1]));
    const winners = [];
    for (const d of roundSnap.docs) {
      const m = d.data();
      if (m.status !== "completed") return "round not settled";
      winners.push(m.winnerId);
    }
    const alive = [...(p.byes || []), ...winners];

    if (alive.length === 1) {
      tx.update(leagueRef, { playoffs: { ...p, status: "complete", alive, byes: [], championTeamId: alive[0], completedAt: Timestamp.now() } });
      return `champion: ${alive[0]}`;
    }
    const teamsSnap = await tx.get(leagueRef.collection("teams"));
    teamsSnap.docs.forEach(d => { nameOf[d.id] = d.data().teamName; });
    const next = p.round + 1;
    const { pairs } = pairRound(alive, seedOf, 0);
    writeRound(next, pairs, seedOf);
    tx.update(leagueRef, { playoffs: { ...p, round: next, alive, byes: [] } });
    return `round ${next}: ${pairs.length} matchups`;
  });
}

/** Winner of a settled playoff matchup: higher score, or the higher seed on a tie. */
function playoffWinner(m, homeScore, awayScore) {
  if (homeScore > awayScore) return m.homeTeamId;
  if (awayScore > homeScore) return m.awayTeamId;
  return (m.homeSeed || 99) <= (m.awaySeed || 99) ? m.homeTeamId : m.awayTeamId;
}

module.exports = { afterWeekSettled, playoffWinner, seedTeams, pairRound, roundCount, roundWeeks };
