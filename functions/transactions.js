/**
 * Server-side processing of waivers and accepted trades.
 *
 * Replaces the client's processWaivers() / processAcceptedTrades(), which ran
 * only when a manager had the app open (so idle leagues never cleared) and
 * raced between browsers. Rules are unchanged from the client versions:
 *
 * Waivers — a player dropped goes on waivers for 48 hours. When the deadline
 * passes, claims are tried in rolling waiver-priority order; the first valid
 * claim wins and that team moves to the bottom of the order. A claim is
 * invalid if its drop player is no longer on the roster or is undroppable, or
 * if the roster would exceed the maximum. With no valid claim the player
 * becomes a free agent.
 *
 * Trades — an accepted trade is processed once its review window ends
 * (`accepted`) or at once (`accepted_immediate`). It is vetoed at the veto
 * threshold, and voided if a team, a traded player or a drop player is no
 * longer valid, or a roster would exceed the maximum.
 *
 * Two client defects are fixed here:
 *  - Waivers: every read now happens before any write (Firestore requires it;
 *    the client failed outright when two waivers expired together), and
 *    rosters are tracked in memory, so a team that wins two players keeps both.
 *  - Trades: the trade is re-read inside its transaction and processed only if
 *    still waiting, so a second run cannot overwrite a processed trade.
 */
const { Timestamp } = require("firebase-admin/firestore");

const WAIVER_HOURS = 48;
const DEFAULT_ROSTER = { bench: 4, forwards: { starters: 6 }, defense: { starters: 4 }, goalies: { starters: 1 } };

function maxRosterSize(rosterSettings) {
  const r = rosterSettings || DEFAULT_ROSTER;
  return (r.bench ?? 4) + (r.forwards?.starters ?? 6) + (r.defense?.starters ?? 4) + (r.goalies?.starters ?? 1);
}

const ms = (ts) => (ts && typeof ts.toMillis === "function" ? ts.toMillis() : null);

/**
 * Process every expired waiver in one league, in one transaction.
 * @returns {Promise<{expired:number, awarded:Array<{playerId:string,teamId:string}>, freeAgents:string[]}>}
 */
async function processLeagueWaivers(db, leagueId, nowMs) {
  const leagueRef = db.collection("fantasy_leagues").doc(leagueId);
  const waiversCol = leagueRef.collection("waivers");
  const claimsCol = leagueRef.collection("waiver_claims");
  const teamsCol = leagueRef.collection("teams");

  return db.runTransaction(async (tx) => {
    // ── Reads (all of them, before any write) ──
    const [leagueSnap, waiversSnap, claimsSnap, teamsSnap] = await Promise.all([
      tx.get(leagueRef), tx.get(waiversCol), tx.get(claimsCol), tx.get(teamsCol)
    ]);
    const result = { expired: 0, awarded: [], freeAgents: [] };
    if (!leagueSnap.exists) return result;

    const expired = waiversSnap.docs
      .map(d => ({ ref: d.ref, ...d.data() }))
      .filter(w => ms(w.waiverDeadline) !== null && ms(w.waiverDeadline) <= nowMs)
      .sort((a, b) => ms(a.waiverDeadline) - ms(b.waiverDeadline) || String(a.playerId).localeCompare(String(b.playerId)));
    if (expired.length === 0) return result;
    result.expired = expired.length;

    const league = leagueSnap.data();
    const maxSize = maxRosterSize(league.rosterSettings);
    const undroppable = new Set((league.undroppable_players || []).map(String));
    const originalOrder = [...(league.waiverOrder || [])];
    let order = [...originalOrder];

    const rosters = {};
    const teamRefs = {};
    for (const t of teamsSnap.docs) {
      rosters[t.id] = [...(t.data().players || [])];
      teamRefs[t.id] = t.ref;
    }
    const ownerOf = (pid) => Object.keys(rosters).find(tid => rosters[tid].includes(pid));

    const claimsByPlayer = {};
    for (const c of claimsSnap.docs) {
      const claim = { ref: c.ref, ...c.data() };
      (claimsByPlayer[claim.playerId] = claimsByPlayer[claim.playerId] || []).push(claim);
    }

    const changedTeams = new Set();
    const newWaivers = [];
    const deletes = [];
    const rank = (teamId) => { const i = order.indexOf(teamId); return i === -1 ? 999 : i; };

    for (const waiver of expired) {
      const playerId = waiver.playerId;
      const claims = (claimsByPlayer[playerId] || [])
        .sort((a, b) => rank(a.teamId) - rank(b.teamId) || (ms(a.createdAt) || 0) - (ms(b.createdAt) || 0));

      let winner = null;
      if (!ownerOf(playerId)) {
        for (const claim of claims) {
          const roster = rosters[claim.teamId];
          if (!roster) { console.log(`[Waivers] ${leagueId}: claim by ${claim.teamId} invalid — team not found.`); continue; }
          const drop = claim.dropPlayerId || null;
          if (drop && !roster.includes(drop)) { console.log(`[Waivers] ${leagueId}: claim by ${claim.teamId} invalid — drop ${drop} not on roster.`); continue; }
          if (drop && undroppable.has(String(drop))) { console.log(`[Waivers] ${leagueId}: claim by ${claim.teamId} invalid — drop ${drop} is undroppable.`); continue; }
          const after = drop ? roster.filter(p => p !== drop) : [...roster];
          if (after.length + 1 > maxSize) { console.log(`[Waivers] ${leagueId}: claim by ${claim.teamId} invalid — roster would be ${after.length + 1}/${maxSize}.`); continue; }

          after.push(playerId);
          rosters[claim.teamId] = after;
          changedTeams.add(claim.teamId);
          if (drop) newWaivers.push({ playerId: drop, droppedByTeamId: claim.teamId });
          order = order.filter(id => id !== claim.teamId).concat(claim.teamId);
          winner = claim.teamId;
          break;
        }
      }

      if (winner) result.awarded.push({ playerId, teamId: winner });
      else result.freeAgents.push(playerId);
      deletes.push(waiver.ref, ...claims.map(c => c.ref));
    }

    // ── Writes ──
    for (const ref of deletes) tx.delete(ref);
    for (const tid of changedTeams) tx.update(teamRefs[tid], { players: rosters[tid] });
    const now = Timestamp.fromMillis(nowMs);
    const deadline = Timestamp.fromMillis(nowMs + WAIVER_HOURS * 3600 * 1000);
    for (const w of newWaivers) {
      tx.set(waiversCol.doc(String(w.playerId)), { playerId: w.playerId, droppedByTeamId: w.droppedByTeamId, waiverDeadline: deadline, createdAt: now });
    }
    if (JSON.stringify(order) !== JSON.stringify(originalOrder)) tx.update(leagueRef, { waiverOrder: order });
    return result;
  });
}

const READY_STATUSES = ["accepted", "accepted_immediate"];

/**
 * Process every accepted trade in one league whose review window has ended.
 * Each trade runs in its own transaction and is re-checked there.
 * @returns {Promise<Record<string,string>>} tradeId → final status
 */
async function processLeagueTrades(db, leagueId, nowMs) {
  const leagueRef = db.collection("fantasy_leagues").doc(leagueId);
  const tradesSnap = await leagueRef.collection("trades").where("status", "in", READY_STATUSES).get();
  const outcomes = {};

  for (const tDoc of tradesSnap.docs) {
    const tradeRef = tDoc.ref;
    outcomes[tDoc.id] = await db.runTransaction(async (tx) => {
      const [tradeSnap, leagueSnap] = await Promise.all([tx.get(tradeRef), tx.get(leagueRef)]);
      if (!tradeSnap.exists || !leagueSnap.exists) return "skipped";
      const trade = tradeSnap.data();
      if (!READY_STATUSES.includes(trade.status)) return "skipped";
      const deadline = ms(trade.processDeadline);
      if (trade.status === "accepted" && deadline !== null && deadline > nowMs) return "waiting";

      const league = leagueSnap.data();
      const vetoThreshold = Number((league.tradeSettings || {}).vetoThreshold ?? 3);
      const pRef = leagueRef.collection("teams").doc(trade.proposerTeamId);
      const rRef = leagueRef.collection("teams").doc(trade.receiverTeamId);
      const [pSnap, rSnap] = await Promise.all([tx.get(pRef), tx.get(rRef)]);

      const finish = (status, why) => {
        tx.update(tradeRef, { status, processedAt: Timestamp.fromMillis(nowMs), ...(why ? { voidReason: why } : {}) });
        console.log(`[Trades] ${leagueId}/${tDoc.id}: ${status}${why ? ` — ${why}` : ""}`);
        return status;
      };

      if ((trade.vetoes || []).length >= vetoThreshold) return finish("vetoed");
      if (!pSnap.exists || !rSnap.exists) return finish("voided", "a team no longer exists");

      const undroppable = new Set((league.undroppable_players || []).map(String));
      const maxSize = maxRosterSize(league.rosterSettings);
      const pRoster = [...(pSnap.data().players || [])];
      const rRoster = [...(rSnap.data().players || [])];
      const pSends = trade.proposerSends || [], rSends = trade.receiverSends || [];
      const pDrops = trade.proposerDrops || [], rDrops = trade.receiverDrops || [];

      if (!pSends.every(id => pRoster.includes(id)) || !rSends.every(id => rRoster.includes(id))) {
        return finish("voided", "a traded player is no longer on the sending roster");
      }
      for (const d of pDrops) if (!pRoster.includes(d) || undroppable.has(String(d))) return finish("voided", `proposer drop ${d} is invalid or undroppable`);
      for (const d of rDrops) if (!rRoster.includes(d) || undroppable.has(String(d))) return finish("voided", `receiver drop ${d} is invalid or undroppable`);

      const pFinal = pRoster.filter(id => !pSends.includes(id) && !pDrops.includes(id)).concat(rSends);
      const rFinal = rRoster.filter(id => !rSends.includes(id) && !rDrops.includes(id)).concat(pSends);
      if (pFinal.length > maxSize || rFinal.length > maxSize) return finish("voided", `a roster would exceed ${maxSize}`);

      tx.update(pRef, { players: pFinal });
      tx.update(rRef, { players: rFinal });
      const now = Timestamp.fromMillis(nowMs);
      const wDeadline = Timestamp.fromMillis(nowMs + WAIVER_HOURS * 3600 * 1000);
      for (const d of pDrops) tx.set(leagueRef.collection("waivers").doc(String(d)), { playerId: d, droppedByTeamId: trade.proposerTeamId, waiverDeadline: wDeadline, createdAt: now });
      for (const d of rDrops) tx.set(leagueRef.collection("waivers").doc(String(d)), { playerId: d, droppedByTeamId: trade.receiverTeamId, waiverDeadline: wDeadline, createdAt: now });
      return finish("processed");
    });
  }
  return outcomes;
}

/** Waivers, then trades, for one league. Errors are logged, not thrown. */
async function processLeagueTransactions(db, leagueId, nowMs) {
  const out = { leagueId };
  try { out.waivers = await processLeagueWaivers(db, leagueId, nowMs); }
  catch (err) { console.error(`[Waivers] ${leagueId}: processing failed:`, err); out.waiversError = String(err.message || err); }
  try { out.trades = await processLeagueTrades(db, leagueId, nowMs); }
  catch (err) { console.error(`[Trades] ${leagueId}: processing failed:`, err); out.tradesError = String(err.message || err); }
  return out;
}

module.exports = { processLeagueWaivers, processLeagueTrades, processLeagueTransactions, maxRosterSize, WAIVER_HOURS };
