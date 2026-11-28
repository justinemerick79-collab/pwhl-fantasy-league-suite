/**
 * Regular-season matchup schedule for real (non-simulation) leagues.
 *
 * Generated once, when a league's draft completes. Matchups are written to
 * fantasy_leagues/{id}/matchups/week_{W}_matchup_{i} in the same shape the
 * simulation league uses, so settlement (finalizeLeagueWeek) and the Matchup
 * screen read them unchanged.
 *
 * Week boundaries come from pwhl_seasons/{season_id}.weeks. There is no
 * default: a season without its week map is skipped loudly (see CLAUDE.md).
 */
const { Timestamp } = require("firebase-admin/firestore");
const { resolveLeagueSeasonId } = require("./leagueSeason");

const BYE = null;

/**
 * Round-robin pairings by the circle method. Every team meets every other team
 * once per cycle. With an odd team count, one team has a bye each round
 * (no matchup document is written for it).
 *
 * @param {string[]} teamIds
 * @returns {Array<Array<[string, string]>>} rounds of [home, away] pairs
 */
function buildRoundRobin(teamIds) {
  const list = [...teamIds];
  if (list.length % 2 === 1) list.push(BYE);
  const n = list.length;
  const rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      // Alternate the fixed team's side so it is not always at home.
      let home = list[i];
      let away = list[n - 1 - i];
      if (i === 0 && r % 2 === 1) [home, away] = [away, home];
      if (home !== BYE && away !== BYE) pairs.push([home, away]);
    }
    rounds.push(pairs);
    // Rotate every position except the first.
    list.splice(1, 0, list.pop());
  }
  return rounds;
}

/** Playoff rounds needed for a bracket of `playoffTeams` (byes fill a 6-team bracket). */
function playoffRoundCount(playoffTeams) {
  const t = Math.max(0, Number(playoffTeams) || 0);
  return t >= 2 ? Math.ceil(Math.log2(t)) : 0;
}

/**
 * Pure planning step: which weeks to schedule, and who plays whom.
 *
 * @param {object} p
 * @param {string[]} p.teamIds
 * @param {Array<{week:number,start:string,end:string,isOffWeek?:boolean}>} p.seasonWeeks
 * @param {number} p.afterMs   only weeks that START at or after this time are used
 * @param {object} [p.scheduleSettings] { matchupDuration, playoffTeams, playoffDuration }
 * @returns {{ ok: true, regularWeeks: number[], playoffWeeks: number[], matchups: Array<{week:number, homeTeamId:string, awayTeamId:string}> }
 *          | { ok: false, reason: string }}
 */
function planSchedule({ teamIds, seasonWeeks, afterMs, scheduleSettings = {} }) {
  if (!Array.isArray(teamIds) || teamIds.length < 2) {
    return { ok: false, reason: `needs at least 2 teams, has ${teamIds ? teamIds.length : 0}` };
  }
  if (!Array.isArray(seasonWeeks) || seasonWeeks.length === 0) {
    return { ok: false, reason: "season has no `weeks` array" };
  }

  const futureWeeks = seasonWeeks
    .filter(w => !w.isOffWeek && new Date(w.start).getTime() >= afterMs)
    .sort((a, b) => a.week - b.week);

  const playoffTeams = Math.min(Number(scheduleSettings.playoffTeams) || 0, teamIds.length);
  const playoffWeekCount = playoffRoundCount(playoffTeams) * Math.max(1, Number(scheduleSettings.playoffDuration) || 1);
  const regularCount = futureWeeks.length - playoffWeekCount;

  if (regularCount < 1) {
    return {
      ok: false,
      reason: `only ${futureWeeks.length} game week(s) remain after the draft; ` +
        `${playoffWeekCount} are needed for playoffs, leaving none for the regular season`
    };
  }

  const regular = futureWeeks.slice(0, regularCount);
  const playoff = futureWeeks.slice(regularCount);

  // matchupDuration > 1 keeps the same pairing for that many consecutive weeks.
  // Each week is still settled on its own (finalizeLeagueWeek is per week).
  const duration = Math.max(1, Number(scheduleSettings.matchupDuration) || 1);
  const rounds = buildRoundRobin(teamIds);
  const matchups = [];
  regular.forEach((w, idx) => {
    const roundIdx = Math.floor(idx / duration);
    const cycle = Math.floor(roundIdx / rounds.length);
    const pairs = rounds[roundIdx % rounds.length];
    for (const [home, away] of pairs) {
      // Swap home and away on every second pass through the round-robin.
      const swap = cycle % 2 === 1;
      matchups.push({ week: w.week, homeTeamId: swap ? away : home, awayTeamId: swap ? home : away });
    }
  });

  return {
    ok: true,
    regularWeeks: regular.map(w => w.week),
    playoffWeeks: playoff.map(w => w.week),
    matchups
  };
}

/**
 * Writes the regular-season schedule for a league, once.
 *
 * Idempotent: if the league already has any matchup documents, or is a
 * simulation league (which builds its own), it does nothing.
 *
 * @returns {Promise<{status: 'created'|'skipped'|'error', reason?: string, count?: number}>}
 */
async function generateLeagueSchedule(db, leagueId, nowMs) {
  const leagueRef = db.collection("fantasy_leagues").doc(leagueId);
  const leagueSnap = await leagueRef.get();
  if (!leagueSnap.exists) return { status: "skipped", reason: "league not found" };
  const league = leagueSnap.data();

  if (league.isSimulation) return { status: "skipped", reason: "simulation league builds its own schedule" };

  const existing = await leagueRef.collection("matchups").limit(1).get();
  if (!existing.empty) return { status: "skipped", reason: "schedule already exists" };

  const seasonId = await resolveLeagueSeasonId(db, leagueId, league);
  if (!seasonId) {
    console.error(`[Schedule] League ${leagueId} skipped: no season_id and no active season.`);
    return { status: "error", reason: "league has no season_id" };
  }
  const seasonSnap = await db.collection("pwhl_seasons").doc(seasonId).get();
  const seasonWeeks = seasonSnap.exists ? seasonSnap.data().weeks : null;
  if (!Array.isArray(seasonWeeks) || seasonWeeks.length === 0) {
    console.error(
      `[Schedule] League ${leagueId} skipped: season ${seasonId} has no \`weeks\` array ` +
      `(pwhl_seasons/${seasonId}). Run the season sync so generateWeeksList() populates it.`
    );
    return { status: "error", reason: `season ${seasonId} has no weeks` };
  }

  const teamsSnap = await leagueRef.collection("teams").get();
  const teams = teamsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  // Stable order so a retry produces the same schedule.
  const teamIds = teams.map(t => t.id).sort();
  const nameOf = Object.fromEntries(teams.map(t => [t.id, t.teamName || "Team"]));

  const plan = planSchedule({ teamIds, seasonWeeks, afterMs: nowMs, scheduleSettings: league.scheduleSettings || {} });
  if (!plan.ok) {
    console.error(`[Schedule] League ${leagueId} skipped: ${plan.reason}.`);
    return { status: "error", reason: plan.reason };
  }

  const createdAt = Timestamp.fromMillis(nowMs);
  const perWeekIndex = {};
  let batch = db.batch();
  let ops = 0;
  for (const m of plan.matchups) {
    perWeekIndex[m.week] = (perWeekIndex[m.week] || 0) + 1;
    const ref = leagueRef.collection("matchups").doc(`week_${m.week}_matchup_${perWeekIndex[m.week]}`);
    batch.set(ref, {
      week: m.week,
      homeTeamId: m.homeTeamId,
      awayTeamId: m.awayTeamId,
      homeTeamName: nameOf[m.homeTeamId],
      awayTeamName: nameOf[m.awayTeamId],
      homeScore: 0,
      awayScore: 0,
      status: "pending",
      createdAt
    });
    if (++ops === 450) { await batch.commit(); batch = db.batch(); ops = 0; }
  }

  // Settlement starts from currentWeek. Point it at the first scheduled week so
  // weeks that ended before the draft are not settled with no games.
  batch.update(leagueRef, {
    currentWeek: plan.regularWeeks[0],
    schedule: {
      regularSeasonWeeks: plan.regularWeeks,
      playoffWeeks: plan.playoffWeeks,
      generatedAt: createdAt
    }
  });
  await batch.commit();

  console.log(
    `[Schedule] League ${leagueId}: ${plan.matchups.length} matchups over weeks ` +
    `${plan.regularWeeks[0]}-${plan.regularWeeks[plan.regularWeeks.length - 1]}; ` +
    `playoff weeks reserved: ${plan.playoffWeeks.join(", ") || "none"}.`
  );
  return { status: "created", count: plan.matchups.length };
}

module.exports = { buildRoundRobin, planSchedule, playoffRoundCount, generateLeagueSchedule };
