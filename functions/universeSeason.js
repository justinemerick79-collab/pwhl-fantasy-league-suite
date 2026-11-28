// The one rule for which season's player pool ("universe") a server reader uses.
//
// A season that has players uses its own pool. A season with no players yet (an
// upcoming season before its rosters are synced) uses the most recent regular
// season (playoff '0', career '1') that starts before it. If none qualifies, the
// season itself is returned and the pool stays empty.
//
// This is a copy of `resolveUniverseSeason` in src/services/pwhlService.js (the
// client cannot share CommonJS code with the functions bundle). Keep the two in
// step; test-season-pool.js runs both over the same cases.

function resolveUniverseSeason(seasonId, seasons, hasPlayers) {
  const target = String(seasonId);
  if (hasPlayers || !Array.isArray(seasons) || seasons.length === 0) {
    return { seasonId: target, isFallback: false };
  }
  const idOf = (s) => String(s.season_id ?? s.id);
  const targetDoc = seasons.find(s => idOf(s) === target);
  const targetStart = targetDoc?.start_date ? new Date(targetDoc.start_date) : new Date();

  const prevRegular = seasons
    .filter(s => {
      const isRegular = (s.playoff === '0' || s.playoff === 0) && (s.career === '1' || s.career === 1);
      return isRegular && idOf(s) !== target && s.start_date && new Date(s.start_date) < targetStart;
    })
    .sort((a, b) => new Date(b.start_date) - new Date(a.start_date));

  if (prevRegular.length === 0) return { seasonId: target, isFallback: false };
  return { seasonId: idOf(prevRegular[0]), isFallback: true };
}

function seasonPlayersQuery(db, seasonId) {
  return db.collection("pwhl_players").where("season_id", "in", [String(seasonId), Number(seasonId)]);
}

/**
 * Loads one season's player pool, applying the fallback rule above.
 * @returns {Promise<{ seasonId: string, isFallback: boolean, docs: FirebaseFirestore.QueryDocumentSnapshot[] }>}
 */
async function loadSeasonPlayerPool(db, seasonId) {
  const target = String(seasonId);
  const snap = await seasonPlayersQuery(db, target).get();
  if (!snap.empty) return { seasonId: target, isFallback: false, docs: snap.docs };

  const seasonsSnap = await db.collection("pwhl_seasons").get();
  const seasons = seasonsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const universe = resolveUniverseSeason(target, seasons, false);
  if (!universe.isFallback) return { seasonId: target, isFallback: false, docs: [] };

  const prevSnap = await seasonPlayersQuery(db, universe.seasonId).get();
  return { seasonId: universe.seasonId, isFallback: true, docs: prevSnap.docs };
}

module.exports = { resolveUniverseSeason, loadSeasonPlayerPool };
