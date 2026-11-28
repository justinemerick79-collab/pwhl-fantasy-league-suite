/**
 * A fantasy league's PWHL season. Leagues store it as `season_id` at creation
 * (leagueService.createLeague). Safety net for a league that lacks it — e.g. one
 * created before 2026-11-28, when creation did not store it: adopt the app's active
 * season (app_settings/active_season), save it on the league, and log a warning.
 * Never a hardcoded default.
 *
 * @returns {Promise<string|null>} the season id, or null if none can be found
 */
async function resolveLeagueSeasonId(db, leagueId, league) {
  if (league && league.season_id !== undefined && league.season_id !== null && league.season_id !== "") {
    return String(league.season_id);
  }
  const active = await db.collection("app_settings").doc("active_season").get();
  const sid = active.exists ? active.data().active_season_id : null;
  if (!sid) {
    console.error(`[League] ${leagueId} has no season_id and no active season is set (app_settings/active_season).`);
    return null;
  }
  await db.collection("fantasy_leagues").doc(leagueId).set({ season_id: String(sid) }, { merge: true });
  console.warn(`[League] ${leagueId} had no season_id; set it to the active season ${sid}.`);
  return String(sid);
}

module.exports = { resolveLeagueSeasonId };
