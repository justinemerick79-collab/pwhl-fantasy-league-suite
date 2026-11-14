import { db } from '../firebase.js';
import { 
  collection, 
  doc, 
  runTransaction,
  serverTimestamp,
  query,
  where,
  getDocs,
  Timestamp,
  getDoc,
  setDoc,
  updateDoc
} from 'firebase/firestore';
import { normalizePosition } from './pwhlService';
import { notifyTradeEvent } from './notificationService';

// Safe date parser: avoids UTC midnight shift for bare "YYYY-MM-DD" strings
function parseDateSafe(dateStr) {
  if (!dateStr) return new Date();
  const s = String(dateStr);
  if (s.includes('T') || s.includes(' ')) return new Date(s);
  const parts = s.split('-').map(Number);
  if (parts.length === 3) return new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0);
  return new Date(s);
}

/**
 * Generates a random 6-character invite code.
 */
function generateInviteCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Creates a new fantasy league with secure transactions and default rules.
 * 
 * @param {string} name - The name of the league.
 * @param {number} maxTeams - The maximum number of teams (4-10).
 * @param {string} userId - The UID of the commissioner creating the league.
 * @param {string} teamName - The name of the commissioner's team.
 */
export async function createLeague(name, maxTeams, userId, teamName) {
  if (maxTeams < 4 || maxTeams > 10) {
    throw new Error("A league must have between 4 and 10 teams.");
  }

  // Generate league and team references
  const leagueRef = doc(collection(db, "fantasy_leagues"));
  const teamRef = doc(collection(leagueRef, "teams"));

  await runTransaction(db, async (transaction) => {
    const inviteCode = generateInviteCode();
    
    // Securely initialize default rules
    const defaultRosterSettings = {
      forwards: { starters: 6, max: 10 },
      defense: { starters: 4, max: 8 },
      goalies: { starters: 1, max: 3 },
      bench: 4
    };

    const defaultScoringSettings = {
      skaters: {
        goals: 2,
        assists: 1,
        plusMinus: 0.5,
        ppp: 0.5,
        shp: 0.5,
        sog: 0.1,
        hits: 0.1,
        blocks: 0.5,
        defensePoints: 0.5
      },
      goalies: {
        wins: 4,
        otl: 1,
        ga: -2,
        saves: 0.2,
        shutouts: 3
      }
    };

    const defaultScheduleSettings = {
      matchupDuration: 1,
      playoffTeams: 4,
      playoffDuration: 1
    };

    transaction.set(leagueRef, {
      name: name,
      ownerId: userId,
      commissionerId: userId,
      maxTeams: maxTeams,
      inviteCode: inviteCode,
      members: [userId],
      userIds: [userId], // backward compatibility mapping
      draftOrder: [userId],
      status: 'pending', // default pending status until draft is set and league is full
      createdAt: serverTimestamp(),
      rosterSettings: defaultRosterSettings,
      scoringSettings: defaultScoringSettings,
      scheduleSettings: defaultScheduleSettings,
      waiverOrder: [] // secure initialized empty waiver order
    });

    transaction.set(teamRef, {
      ownerId: userId,
      teamName: teamName,
      joinedAt: serverTimestamp()
    });
  });

  return leagueRef.id;
}

/**
 * Joins an existing fantasy league securely via transaction.
 * Prevents joining if league is full or user already joined.
 * 
 * @param {string} inviteCode - The unique 6-character invite code of the league.
 * @param {string} userId - The UID of the user joining.
 * @param {string} teamName - The user's team name.
 */
export async function joinLeague(inviteCode, userId, teamName) {
  if (!inviteCode) {
    throw new Error("Invite code is required.");
  }

  // 1. Query for the league by invite code outside transaction (queries are disallowed inside transactions)
  const q = query(collection(db, "fantasy_leagues"), where("inviteCode", "==", inviteCode.toUpperCase()));
  const snap = await getDocs(q);
  
  if (snap.empty) {
    throw new Error("Invalid invite code. League not found.");
  }

  const leagueDoc = snap.docs[0];
  const leagueRef = doc(db, "fantasy_leagues", leagueDoc.id);
  const teamRef = doc(collection(leagueRef, "teams"));

  // 2. Perform concurrent safety transaction
  await runTransaction(db, async (transaction) => {
    const leagueSnap = await transaction.get(leagueRef);
    if (!leagueSnap.exists()) {
      throw new Error("League does not exist.");
    }

    const leagueData = leagueSnap.data();
    const currentMembers = leagueData.members || leagueData.userIds || [];

    if (currentMembers.includes(userId)) {
      throw new Error("You are already a member of this league.");
    }

    if (currentMembers.length >= leagueData.maxTeams) {
      throw new Error("This league is already full.");
    }

    const updatedMembers = [...currentMembers, userId];
    
    // Status advances once league gets full, commission can set draft and activate
    const isFull = updatedMembers.length === leagueData.maxTeams;
    const newStatus = leagueData.status === 'pending' ? 'pending' : (isFull ? 'active_full' : 'active_not_full');

    const updatedDraftOrder = [...(leagueData.draftOrder || currentMembers), userId];

    transaction.update(leagueRef, {
      members: updatedMembers,
      userIds: updatedMembers, // maintain backwards compatibility
      draftOrder: updatedDraftOrder,
      status: newStatus
    });

    transaction.set(teamRef, {
      ownerId: userId,
      teamName: teamName,
      joinedAt: serverTimestamp()
    });
  });
}

/**
 * Deletes an existing league securely via transaction.
 * 
 * @param {string} leagueId 
 */
export async function deleteLeague(leagueId) {
  const leagueRef = doc(db, "fantasy_leagues", leagueId);
  await runTransaction(db, async (transaction) => {
    const snap = await transaction.get(leagueRef);
    if (snap.exists()) {
      transaction.delete(leagueRef);
    }
  });
}

/**
 * Reassigns the ownership of a team to a new user securely via transaction.
 * 
 * @param {string} leagueId 
 * @param {string} teamId 
 * @param {string} oldOwnerId 
 * @param {string} newOwnerId 
 */
export async function reassignTeamOwner(leagueId, teamId, oldOwnerId, newOwnerId) {
  const leagueRef = doc(db, "fantasy_leagues", leagueId);
  const teamRef = doc(db, `fantasy_leagues/${leagueId}/teams`, teamId);

  await runTransaction(db, async (transaction) => {
    const leagueSnap = await transaction.get(leagueRef);
    const teamSnap = await transaction.get(teamRef);

    if (!leagueSnap.exists() || !teamSnap.exists()) {
      throw new Error("League or team not found.");
    }

    const leagueData = leagueSnap.data();
    const currentMembers = leagueData.members || leagueData.userIds || [];

    const updatedMembers = currentMembers
      .filter(uid => uid !== oldOwnerId)
      .concat(newOwnerId);

    transaction.update(leagueRef, {
      members: updatedMembers,
      userIds: updatedMembers
    });

    transaction.update(teamRef, {
      ownerId: newOwnerId
    });
  });
}

/**
 * Randomizes the draft order for the league.
 * Can only be done if the draft is not scheduled yet.
 * 
 * @param {string} leagueId 
 */
export async function randomizeDraftOrder(leagueId) {
  const leagueRef = doc(db, "fantasy_leagues", leagueId);
  await runTransaction(db, async (transaction) => {
    const snap = await transaction.get(leagueRef);
    if (!snap.exists()) {
      throw new Error("League does not exist.");
    }
    const data = snap.data();
    if (data.draftDate) {
      throw new Error("Draft order is locked because the draft is already scheduled.");
    }
    
    const order = [...(data.draftOrder || data.members || [])];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    
    transaction.update(leagueRef, {
      draftOrder: order
    });
  });
}

/**
 * Initializes a new snake draft for a fantasy league.
 * Creates the initial draft/state subcollection document.
 * 
 * @param {string} leagueId 
 * @param {Array<string>} draftOrder - Array of userIds representing draft order
 */
export async function initializeDraft(leagueId, draftOrder) {
  if (!draftOrder || draftOrder.length === 0) {
    throw new Error("Draft order must contain at least one participant.");
  }

  const leagueRef = doc(db, "fantasy_leagues", leagueId);
  const draftStateRef = doc(db, `fantasy_leagues/${leagueId}/draft`, "state");

  await runTransaction(db, async (transaction) => {
    const leagueSnap = await transaction.get(leagueRef);
    if (!leagueSnap.exists()) {
      throw new Error("League does not exist.");
    }

    const activeRosters = {};
    const autoDraftUsers = {};

    // Fetch user documents within transaction to see who is a bot (all reads first)
    const userSnaps = await Promise.all(
      draftOrder.map(uid => transaction.get(doc(db, "users", uid)))
    );

    draftOrder.forEach((uid, index) => {
      activeRosters[uid] = [];
      const userSnap = userSnaps[index];
      if (userSnap.exists() && userSnap.data().isBot) {
        autoDraftUsers[uid] = true;
      }
    });

    const nowMs = Date.now();
    const pickDeadline = Timestamp.fromMillis(nowMs + 60000); // 60 seconds from now

    transaction.set(draftStateRef, {
      status: 'active',
      draftOrder: draftOrder,
      currentRound: 1,
      currentPickIndex: 0,
      currentTeamOnClock: draftOrder[0],
      pickDeadline: pickDeadline,
      picks: [],
      activeRosters: activeRosters,
      autoDraftUsers: autoDraftUsers,
      createdAt: serverTimestamp()
    });

    transaction.update(leagueRef, {
      status: 'drafting'
    });
  });
}

/**
 * Atomic transaction to submit a draft pick.
 * Computes traditional snake format sequencing, assigns player to roster,
 * pulls them from available pool, and updates/advances turns.
 * Supports auto-pick timeouts if isAutoPick is true.
 * 
 * @param {string} leagueId 
 * @param {string} userId - The user making the pick (or currently on the clock)
 * @param {string} playerId - The player ID being drafted
 * @param {boolean} isAutoPick - Set true to trigger timeout auto-assignment
 * @param {boolean} timedOut - Set true if the pick was forced due to time expiration, putting the user on auto-draft
 */
export async function submitDraftPick(leagueId, userId, playerId, isAutoPick = false, timedOut = false) {
  const leagueRef = doc(db, "fantasy_leagues", leagueId);
  const draftStateRef = doc(db, `fantasy_leagues/${leagueId}/draft`, "state");

  // Pre-fetch team references to update rosters during the transaction
  const teamsSnap = await getDocs(collection(db, `fantasy_leagues/${leagueId}/teams`));
  const teamRefsByOwner = {};
  teamsSnap.forEach(d => {
    teamRefsByOwner[d.data().ownerId] = doc(db, `fantasy_leagues/${leagueId}/teams`, d.id);
  });

  await runTransaction(db, async (transaction) => {
    const leagueSnap = await transaction.get(leagueRef);
    const draftSnap = await transaction.get(draftStateRef);

    if (!leagueSnap.exists() || !draftSnap.exists()) {
      throw new Error("League or draft state not found.");
    }

    const draftData = draftSnap.data();
    if (draftData.status !== 'active') {
      throw new Error(`Draft is not active. Current status: ${draftData.status}`);
    }

    const now = Timestamp.now();
    const isExpired = now.seconds > draftData.pickDeadline.seconds;

    // Verify turn authorization:
    // If not expired, the userId MUST match the currentTeamOnClock.
    // If expired and isAutoPick is true, allow the auto-pick trigger to proceed.
    if (!isExpired && draftData.currentTeamOnClock !== userId) {
      throw new Error(`It is not your turn to pick. Current picker on clock: ${draftData.currentTeamOnClock}`);
    }
    if (isExpired && !isAutoPick && draftData.currentTeamOnClock !== userId) {
      throw new Error(`Clock has expired. A timeout auto-pick must be triggered.`);
    }

    // Verify player is not already selected (atomic protection)
    const existingPicks = draftData.picks || [];
    const isAlreadyDrafted = existingPicks.some(p => p.playerId === playerId);
    if (isAlreadyDrafted) {
      throw new Error(`Player ${playerId} is already selected in this draft.`);
    }

    const N = draftData.draftOrder.length;
    const rosterSettings = leagueSnap.data().rosterSettings || { bench: 4, forwards: { starters: 6 }, defense: { starters: 4 }, goalies: { starters: 1 } };

    // Resolve player position
    const playerRef = doc(db, "pwhl_players", playerId);
    const playerSnap = await transaction.get(playerRef);
    let playerPos = 'F';
    if (playerSnap.exists()) {
      playerPos = normalizePosition(playerSnap.data().position);
    } else {
      const numId = parseInt(String(playerId).replace(/^\D+/g, ''), 10);
      if (!isNaN(numId)) {
        if (numId >= 12 && numId <= 14) playerPos = "G";
        else if (numId >= 8 && numId <= 11) playerPos = "D";
      }
    }

    // Verify roster position maximums limits and active roster requirements
    const currentRosterIds = draftData.activeRosters[draftData.currentTeamOnClock] || [];
    let fCount = 0;
    let dCount = 0;
    let gCount = 0;

    for (const pId of currentRosterIds) {
      const pRef = doc(db, "pwhl_players", pId);
      const pSnap = await transaction.get(pRef);
      let pPos = 'F';
      if (pSnap.exists()) {
        pPos = normalizePosition(pSnap.data().position);
      } else {
        const numId = parseInt(String(pId).replace(/^\D+/g, ''), 10);
        if (!isNaN(numId)) {
          if (numId >= 12 && numId <= 14) pPos = "G";
          else if (numId >= 8 && numId <= 11) pPos = "D";
        }
      }
      if (pPos === 'F') fCount++;
      else if (pPos === 'D') dCount++;
      else if (pPos === 'G') gCount++;
    }

    const posCount = playerPos === 'F' ? fCount :
                     playerPos === 'D' ? dCount :
                     gCount;

    let nextFCount = fCount;
    let nextDCount = dCount;
    let nextGCount = gCount;
    if (playerPos === 'F') nextFCount++;
    else if (playerPos === 'D') nextDCount++;
    else if (playerPos === 'G') nextGCount++;

    const forwardsLimit = rosterSettings.forwards?.max ?? 10;
    const defenseLimit = rosterSettings.defense?.max ?? 8;
    const goaliesLimit = rosterSettings.goalies?.max ?? 3;

    if (playerPos === 'F' && nextFCount > forwardsLimit) {
      throw new Error(`Roster limit exceeded for position F. Maximum allowed is ${forwardsLimit}.`);
    }
    if (playerPos === 'D' && nextDCount > defenseLimit) {
      throw new Error(`Roster limit exceeded for position D. Maximum allowed is ${defenseLimit}.`);
    }
    if (playerPos === 'G' && nextGCount > goaliesLimit) {
      throw new Error(`Roster limit exceeded for position G. Maximum allowed is ${goaliesLimit}.`);
    }

    const fStarters = rosterSettings.forwards?.starters ?? 6;
    const dStarters = rosterSettings.defense?.starters ?? 4;
    const gStarters = rosterSettings.goalies?.starters ?? 1;
    const benchSlots = rosterSettings.bench ?? 4;
    const totalRosterSize = fStarters + dStarters + gStarters + benchSlots;

    const picksRemaining = totalRosterSize - currentRosterIds.length;
    const nextPicksRemaining = picksRemaining - 1;

    const fNeeded = Math.max(0, fStarters - nextFCount);
    const dNeeded = Math.max(0, dStarters - nextDCount);
    const gNeeded = Math.max(0, gStarters - nextGCount);
    const totalNeeded = fNeeded + dNeeded + gNeeded;

    if (nextPicksRemaining < totalNeeded) {
      throw new Error(`Invalid draft pick. You must draft a player from a position that helps fill your remaining starter requirements (Forwards: ${fNeeded}, Defense: ${dNeeded}, Goalies: ${gNeeded}) with your ${nextPicksRemaining} remaining picks.`);
    }

    const totalPicks = totalRosterSize * N;

    // Execute pick insertion
    const pickerUserId = draftData.currentTeamOnClock;
    const globalPickNumber = draftData.currentPickIndex + 1;
    const currentRound = draftData.currentRound;

    const newPick = {
      round: currentRound,
      pickNumber: globalPickNumber,
      userId: pickerUserId,
      playerId: playerId,
      timestamp: now
    };

    const updatedPicks = [...existingPicks, newPick];
    
    const activeRosters = { ...draftData.activeRosters };
    activeRosters[pickerUserId] = [...(activeRosters[pickerUserId] || []), playerId];

    // Sync the drafted player immediately to the user's team document
    const pickerTeamRef = teamRefsByOwner[pickerUserId];
    if (pickerTeamRef) {
      const teamSnap = await transaction.get(pickerTeamRef);
      if (teamSnap.exists()) {
        const teamData = teamSnap.data();
        const activePlayers = teamData.activePlayers || [];
        const benchPlayers = teamData.benchPlayers || [];

        const startersLimit = playerPos === 'F' ? (rosterSettings.forwards?.starters ?? 6) :
                              playerPos === 'D' ? (rosterSettings.defense?.starters ?? 4) :
                              (rosterSettings.goalies?.starters ?? 1);

        if (posCount >= startersLimit) {
          benchPlayers.push(playerId);
        } else {
          activePlayers.push(playerId);
        }

        transaction.update(pickerTeamRef, {
          players: activeRosters[pickerUserId],
          activePlayers,
          benchPlayers
        });
      }
    }

    // Advance Draft Turn Index & Snake Calculations
    const nextPickIndex = draftData.currentPickIndex + 1;
    let nextRound = draftData.currentRound;
    let nextTeamOnClock = null;
    let nextStatus = 'active';

    if (nextPickIndex >= totalPicks) {
      nextStatus = 'completed';
      console.log(`Draft completed after ${totalPicks} picks!`);
    } else {
      nextRound = Math.floor(nextPickIndex / N) + 1;
      const pos = nextPickIndex % N;
      if (nextRound % 2 !== 0) {
        // Odd round: Left to Right
        nextTeamOnClock = draftData.draftOrder[pos];
      } else {
        // Even round: Right to Left (Snake)
        nextTeamOnClock = draftData.draftOrder[(N - 1) - pos];
      }
    }

    const nextDeadline = Timestamp.fromMillis(Date.now() + 60000);

    const autoDraftUsers = { ...(draftData.autoDraftUsers || {}) };
    if (timedOut) {
      autoDraftUsers[pickerUserId] = true;
    }

    transaction.update(draftStateRef, {
      status: nextStatus,
      currentRound: nextRound,
      currentPickIndex: nextPickIndex,
      currentTeamOnClock: nextTeamOnClock || pickerUserId,
      pickDeadline: nextDeadline,
      picks: updatedPicks,
      activeRosters: activeRosters,
      autoDraftUsers: autoDraftUsers
    });

    if (nextStatus === 'completed') {
      transaction.update(leagueRef, {
        status: 'active' // Draft is complete, league is now active!
      });
    }
  });
}

/**
 * Toggles the auto-draft status for a user in the draft.
 * 
 * @param {string} leagueId 
 * @param {string} userId 
 * @param {boolean} isAutoDraft 
 */
export async function toggleAutoDraftStatus(leagueId, userId, isAutoDraft) {
  const draftStateRef = doc(db, `fantasy_leagues/${leagueId}/draft`, "state");
  await runTransaction(db, async (transaction) => {
    const draftSnap = await transaction.get(draftStateRef);
    if (!draftSnap.exists()) return;
    
    const draftData = draftSnap.data();
    const autoDraftUsers = { ...(draftData.autoDraftUsers || {}) };
    autoDraftUsers[userId] = isAutoDraft;
    
    transaction.update(draftStateRef, {
      autoDraftUsers: autoDraftUsers
    });
  });
}

let testDateOverride = null;

/**
 * Sets a temporary simulated date override for testing transactions without modifying DB rules.
 * @param {Date|null} date 
 */
export function setTestDateOverride(date) {
  testDateOverride = date;
}

/**
 * Helper to fetch the active simulated time travel date or current system date.
 */
export async function getSimulatedSystemDate() {
  if (testDateOverride) {
    return testDateOverride;
  }
  try {
    const simSnap = await getDoc(doc(db, "admin_settings", "simulation_state"));
    if (simSnap.exists()) {
      const simData = simSnap.data();
      if (simData.testModeActive === true && simData.current_simulated_date) {
        return new Date(`${simData.current_simulated_date}T08:00:00-08:00`);
      }
    }
  } catch (err) {
    console.error("Error reading admin_settings/simulation_state:", err);
  }

  return new Date();
}

/**
 * Performs an atomic Add/Drop Free Agency swap.
 * Validates roster limits and places dropped player on a 48-hour waiver.
/**
 * Calculates the top 50 athletes in the league based on total fantasy points
 * and updates the league's undroppable_players list in Firestore.
 */
export async function updateWeeklyTop50Undroppable(leagueId) {
  try {
    const leagueRef = doc(db, "fantasy_leagues", leagueId);
    const leagueSnap = await getDoc(leagueRef);
    if (!leagueSnap.exists()) return [];

    const leagueData = leagueSnap.data();
    const seasonId = leagueData.season_id ? String(leagueData.season_id) : '5';

    // Fetch all players for this season
    const playersSnap = await getDocs(collection(db, "pwhl_players"));
    const playersList = [];

    playersSnap.forEach(pDoc => {
      const pData = pDoc.data();
      const id = pData.player_id || pData.id || pDoc.id.split('_')[1];
      const stats = pData.stats?.[seasonId] || {};
      const fpts = pData.fpts || stats.points || stats.fpts || 0;
      playersList.push({
        id: String(id),
        name: pData.name || `${pData.first_name || ''} ${pData.last_name || ''}`.trim(),
        fpts: Number(fpts) || 0,
        rank: pData.overallRank || 999
      });
    });

    // Sort by FPTS descending (or overallRank ascending if FPTS is 0 during preseason)
    playersList.sort((a, b) => {
      if (b.fpts !== a.fpts) return b.fpts - a.fpts;
      return a.rank - b.rank;
    });

    const top50Ids = playersList.slice(0, 50).map(p => p.id);

    await updateDoc(leagueRef, {
      undroppable_players: top50Ids,
      undroppable_updated_at: serverTimestamp()
    });

    console.log(`Updated Top 50 Undroppable list for league ${leagueId}. Count: ${top50Ids.length}`);
    return top50Ids;
  } catch (err) {
    console.error(`Error updating undroppable list for league ${leagueId}:`, err);
    return [];
  }
}

/**
 * Performs an atomic Add/Drop Free Agency swap.
 * Validates roster limits, checks Undroppable Top 50 list, and places dropped player on a 48-hour waiver.
 */
export async function submitAddDrop(leagueId, teamId, userId, addPlayerId, dropPlayerId) {
  const leagueRef = doc(db, "fantasy_leagues", leagueId);
  const teamRef = doc(db, `fantasy_leagues/${leagueId}/teams`, teamId);

  const simulatedDate = await getSimulatedSystemDate();

  await runTransaction(db, async (transaction) => {
    const leagueSnap = await transaction.get(leagueRef);
    const teamSnap = await transaction.get(teamRef);

    if (!leagueSnap.exists() || !teamSnap.exists()) {
      throw new Error("League or team not found.");
    }

    const leagueData = leagueSnap.data();
    const undroppableList = leagueData.undroppable_players || [];

    const teamData = teamSnap.data();
    if (teamData.ownerId !== userId) {
      throw new Error("Unauthorized: You do not own this team.");
    }

    const currentRoster = teamData.players || [];
    
    // Verify drop player is owned
    if (dropPlayerId && !currentRoster.includes(dropPlayerId)) {
      throw new Error(`Player ${dropPlayerId} is not on your roster.`);
    }

    // Verify drop player is NOT on the Undroppable Top 50 list
    if (dropPlayerId && undroppableList.includes(dropPlayerId)) {
      throw new Error(`This player is on the league Top 50 Undroppable List and cannot be dropped to free agency.`);
    }

    // Verify add player is a Free Agent (not owned by anyone in this league)
    const teamsQuerySnap = await getDocs(collection(db, `fantasy_leagues/${leagueId}/teams`));
    const allOwnedPlayers = new Set();
    teamsQuerySnap.forEach(tDoc => {
      const tPlayers = tDoc.data().players || [];
      tPlayers.forEach(pId => allOwnedPlayers.add(pId));
    });

    if (allOwnedPlayers.has(addPlayerId)) {
      throw new Error(`Player ${addPlayerId} is already owned by another team in this league.`);
    }

    // Verify player is not on waivers
    const waiverSnap = await transaction.get(doc(db, `fantasy_leagues/${leagueId}/waivers`, addPlayerId));
    if (waiverSnap.exists()) {
      throw new Error(`Player ${addPlayerId} is on waivers. You must submit a waiver claim instead.`);
    }

    // Validate Roster Limits
    const rosterSettings = leagueData.rosterSettings || { bench: 4, forwards: { starters: 6 }, defense: { starters: 4 }, goalies: { starters: 1 } };
    const maxRosterSize = (rosterSettings.bench ?? 4) + 
                          (rosterSettings.forwards?.starters ?? 6) + 
                          (rosterSettings.defense?.starters ?? 4) + 
                          (rosterSettings.goalies?.starters ?? 1);

    // If current roster is full and adding a player, a drop is MANDATORY
    if (currentRoster.length >= maxRosterSize && addPlayerId && !dropPlayerId) {
      throw new Error(`Your roster is full (${currentRoster.length}/${maxRosterSize}). You must select a player to drop to complete this transaction.`);
    }

    // Compute new roster size
    let updatedRoster = [...currentRoster];
    if (dropPlayerId) {
      updatedRoster = updatedRoster.filter(pId => pId !== dropPlayerId);
    }
    if (addPlayerId) {
      updatedRoster.push(addPlayerId);
    }

    if (updatedRoster.length > maxRosterSize) {
      throw new Error(`Roster limit exceeded. Max roster size is ${maxRosterSize} players.`);
    }

    // Perform Roster Write
    transaction.update(teamRef, {
      players: updatedRoster
    });

    // If a player was dropped, place them on waivers for 48 hours
    if (dropPlayerId) {
      const waiverDeadline = new Date(simulatedDate.getTime() + 48 * 60 * 60 * 1000); // +48 hours
      const waiverRef = doc(db, `fantasy_leagues/${leagueId}/waivers`, dropPlayerId);
      
      transaction.set(waiverRef, {
        playerId: dropPlayerId,
        droppedByTeamId: teamId,
        waiverDeadline: Timestamp.fromDate(waiverDeadline),
        createdAt: Timestamp.fromDate(simulatedDate)
      });
    }
  });
}

/**
 * Submits a waiver claim for a player currently on waivers.
 */
export async function submitWaiverClaim(leagueId, teamId, userId, playerId, dropPlayerId) {
  const leagueRef = doc(db, "fantasy_leagues", leagueId);
  const teamRef = doc(db, `fantasy_leagues/${leagueId}/teams`, teamId);
  const waiverRef = doc(db, `fantasy_leagues/${leagueId}/waivers`, playerId);
  
  const simulatedDate = await getSimulatedSystemDate();

  await runTransaction(db, async (transaction) => {
    const leagueSnap = await transaction.get(leagueRef);
    const teamSnap = await transaction.get(teamRef);
    const waiverSnap = await transaction.get(waiverRef);

    if (!leagueSnap.exists() || !teamSnap.exists() || !waiverSnap.exists()) {
      throw new Error("League, team, or waiver player not found.");
    }

    const leagueData = leagueSnap.data();
    const undroppableList = leagueData.undroppable_players || [];

    const teamData = teamSnap.data();
    if (teamData.ownerId !== userId) {
      throw new Error("Unauthorized: You do not own this team.");
    }

    const currentRoster = teamData.players || [];

    if (dropPlayerId && !currentRoster.includes(dropPlayerId)) {
      throw new Error(`Designated drop player ${dropPlayerId} is not on your roster.`);
    }

    if (dropPlayerId && undroppableList.includes(dropPlayerId)) {
      throw new Error(`Designated drop player is on the Top 50 Undroppable List and cannot be dropped.`);
    }

    const rosterSettings = leagueData.rosterSettings || { bench: 4, forwards: { starters: 6 }, defense: { starters: 4 }, goalies: { starters: 1 } };
    const maxRosterSize = (rosterSettings.bench ?? 4) + 
                          (rosterSettings.forwards?.starters ?? 6) + 
                          (rosterSettings.defense?.starters ?? 4) + 
                          (rosterSettings.goalies?.starters ?? 1);

    if (currentRoster.length >= maxRosterSize && !dropPlayerId) {
      throw new Error(`Your roster is full (${currentRoster.length}/${maxRosterSize}). You must designate a player to drop for this waiver claim.`);
    }

    const claimId = `${teamId}_${playerId}`;
    const claimRef = doc(db, `fantasy_leagues/${leagueId}/waiver_claims`, claimId);

    transaction.set(claimRef, {
      teamId,
      userId,
      playerId,
      dropPlayerId: dropPlayerId || null,
      createdAt: Timestamp.fromDate(simulatedDate)
    });
  });
}

/**
 * Processes all expired waiver claims based on the league's rolling waiver priority queue.
 * Handles execution-time validation per claim in priority order, bypassing invalid claims
 * and falling back to the next highest priority manager who claimed the player.
 */
export async function processWaivers(leagueId) {
  const leagueRef = doc(db, "fantasy_leagues", leagueId);
  const simulatedDate = await getSimulatedSystemDate();

  await runTransaction(db, async (transaction) => {
    const leagueSnap = await transaction.get(leagueRef);
    if (!leagueSnap.exists()) {
      throw new Error("League not found.");
    }

    const leagueData = leagueSnap.data();
    const waiverOrder = leagueData.waiverOrder || [];
    const undroppableList = new Set(leagueData.undroppable_players || []);

    const rosterSettings = leagueData.rosterSettings || { bench: 4, forwards: { starters: 6 }, defense: { starters: 4 }, goalies: { starters: 1 } };
    const maxRosterSize = (rosterSettings.bench ?? 4) + 
                          (rosterSettings.forwards?.starters ?? 6) + 
                          (rosterSettings.defense?.starters ?? 4) + 
                          (rosterSettings.goalies?.starters ?? 1);

    // Fetch all expired waivers
    const waiversSnap = await getDocs(collection(db, `fantasy_leagues/${leagueId}/waivers`));
    const expiredWaivers = [];
    
    waiversSnap.forEach(wDoc => {
      const data = wDoc.data();
      const deadline = data.waiverDeadline.toDate();
      if (deadline <= simulatedDate) {
        expiredWaivers.push(data);
      }
    });

    if (expiredWaivers.length === 0) {
      console.log("No expired waivers to process.");
      return;
    }

    // Fetch all claims
    const claimsSnap = await getDocs(collection(db, `fantasy_leagues/${leagueId}/waiver_claims`));
    const claimsByPlayer = {};
    claimsSnap.forEach(cDoc => {
      const claim = cDoc.data();
      if (!claimsByPlayer[claim.playerId]) {
        claimsByPlayer[claim.playerId] = [];
      }
      claimsByPlayer[claim.playerId].push(claim);
    });

    let currentWaiverOrder = [...waiverOrder];

    for (const waiver of expiredWaivers) {
      const playerId = waiver.playerId;
      const claims = claimsByPlayer[playerId] || [];
      const waiverDocRef = doc(db, `fantasy_leagues/${leagueId}/waivers`, playerId);

      if (claims.length === 0) {
        // No claims submitted: player becomes Free Agent
        transaction.delete(waiverDocRef);
        console.log(`Waiver expired for player ${playerId}. Player is now a Free Agent.`);
        continue;
      }

      // Sort claims strictly by claiming team's position in currentWaiverOrder
      const sortedClaims = [...claims].sort((a, b) => {
        let idxA = currentWaiverOrder.indexOf(a.teamId);
        let idxB = currentWaiverOrder.indexOf(b.teamId);
        if (idxA === -1) idxA = 999;
        if (idxB === -1) idxB = 999;
        return idxA - idxB;
      });

      let successfulClaim = null;

      // Iterate through claims in priority order; fallback to next highest if invalid!
      for (const claim of sortedClaims) {
        const claimingTeamId = claim.teamId;
        const dropPlayerId = claim.dropPlayerId;

        const teamRef = doc(db, `fantasy_leagues/${leagueId}/teams`, claimingTeamId);
        const teamSnap = await transaction.get(teamRef);

        if (!teamSnap.exists()) {
          console.log(`Waiver Claim by ${claimingTeamId} invalid: Team not found.`);
          continue;
        }

        const teamData = teamSnap.data();
        let roster = [...(teamData.players || [])];

        // Execution-Time Validation 1: Verify dropPlayerId if specified
        if (dropPlayerId) {
          if (!roster.includes(dropPlayerId)) {
            console.log(`Waiver Claim by ${claimingTeamId} invalid: Drop player ${dropPlayerId} is no longer on team roster.`);
            continue;
          }
          if (undroppableList.has(dropPlayerId)) {
            console.log(`Waiver Claim by ${claimingTeamId} invalid: Drop player ${dropPlayerId} is on Undroppable List.`);
            continue;
          }
        }

        // Execution-Time Validation 2: Verify roster limits
        const tempRoster = dropPlayerId ? roster.filter(id => id !== dropPlayerId) : roster;
        if (tempRoster.length + 1 > maxRosterSize) {
          console.log(`Waiver Claim by ${claimingTeamId} invalid: Post-transaction roster size (${tempRoster.length + 1}) exceeds max limit of ${maxRosterSize}.`);
          continue;
        }

        // Claim is VALID! Execute atomic transaction
        let updatedRoster = tempRoster;
        updatedRoster.push(playerId);

        transaction.update(teamRef, { players: updatedRoster });

        if (dropPlayerId) {
          const nextWaiverDeadline = new Date(simulatedDate.getTime() + 48 * 60 * 60 * 1000);
          const dropWaiverRef = doc(db, `fantasy_leagues/${leagueId}/waivers`, dropPlayerId);
          transaction.set(dropWaiverRef, {
            playerId: dropPlayerId,
            droppedByTeamId: claimingTeamId,
            waiverDeadline: Timestamp.fromDate(nextWaiverDeadline),
            createdAt: Timestamp.fromDate(simulatedDate)
          });
        }

        // Rotate priority: Move winning team to bottom of rolling queue
        currentWaiverOrder = currentWaiverOrder.filter(id => id !== claimingTeamId);
        currentWaiverOrder.push(claimingTeamId);

        successfulClaim = claim;
        console.log(`Waiver Claim Successful! Player ${playerId} assigned to team ${claimingTeamId}.`);
        break; // Stop evaluating claims for this player once successfully executed
      }

      if (!successfulClaim) {
        console.log(`All submitted waiver claims for player ${playerId} were invalid at execution time. Player is now a Free Agent.`);
      }

      // Cleanup processed waiver document & delete claims
      transaction.delete(waiverDocRef);
      claims.forEach(claim => {
        const claimId = `${claim.teamId}_${playerId}`;
        transaction.delete(doc(db, `fantasy_leagues/${leagueId}/waiver_claims`, claimId));
      });
    }

    // Write updated rolling waiver order queue back to the league document
    transaction.update(leagueRef, {
      waiverOrder: currentWaiverOrder
    });
  });
}

/**
 * Submits a trade proposal between two teams.
 */
export async function submitTradeProposal(leagueId, proposerTeamId, receiverTeamId, proposerSends, receiverSends, proposerDrops = [], receiverDrops = []) {
  const simulatedDate = await getSimulatedSystemDate();
  const tradeId = doc(collection(db, `fantasy_leagues/${leagueId}/trades`)).id;
  const tradeRef = doc(db, `fantasy_leagues/${leagueId}/trades`, tradeId);

  const tradeData = {
    tradeId,
    proposerTeamId,
    receiverTeamId,
    proposerSends,
    receiverSends,
    proposerDrops,
    receiverDrops,
    status: 'pending',
    vetoes: [],
    proposalDate: Timestamp.fromDate(simulatedDate)
  };

  await setDoc(tradeRef, tradeData);

  try {
    const teamsSnap = await getDocs(collection(db, `fantasy_leagues/${leagueId}/teams`));
    const teamsMap = {};
    teamsSnap.forEach(tDoc => teamsMap[tDoc.id] = { id: tDoc.id, ...tDoc.data() });
    await notifyTradeEvent('proposed', leagueId, tradeData, { proposerTeamId, receiverTeamId, teamsMap });
  } catch (nErr) {
    console.error("Notification dispatch error:", nErr);
  }
  
  return tradeId;
}

/**
 * Responds to a trade proposal (Accept or Reject).
 */
export async function respondToTrade(leagueId, tradeId, userId, response, receiverDrops = []) {
  const tradeRef = doc(db, `fantasy_leagues/${leagueId}/trades`, tradeId);
  const leagueRef = doc(db, "fantasy_leagues", leagueId);
  const simulatedDate = await getSimulatedSystemDate();

  await runTransaction(db, async (transaction) => {
    const tradeSnap = await transaction.get(tradeRef);
    const leagueSnap = await transaction.get(leagueRef);

    if (!tradeSnap.exists() || !leagueSnap.exists()) {
      throw new Error("Trade proposal or league not found.");
    }

    const tradeData = tradeSnap.data();
    if (tradeData.status !== 'pending') {
      throw new Error(`Trade is not in a pending state. Current status: ${tradeData.status}`);
    }

    const receiverTeamRef = doc(db, `fantasy_leagues/${leagueId}/teams`, tradeData.receiverTeamId);
    const receiverTeamSnap = await transaction.get(receiverTeamRef);
    
    if (!receiverTeamSnap.exists() || receiverTeamSnap.data().ownerId !== userId) {
      throw new Error("Unauthorized: Only the proposal recipient co-owner can respond.");
    }

    if (response === 'accept') {
      const tradeSettings = leagueSnap.data().tradeSettings || { tradeReviewHours: 48, enableVetoes: true, vetoThreshold: 3, notifyAcceptedTrades: true };
      const reviewHours = Number(tradeSettings.tradeReviewHours ?? 48);
      const enableVetoes = tradeSettings.enableVetoes !== false;

      const processDeadline = new Date(simulatedDate.getTime() + reviewHours * 60 * 60 * 1000);

      const updates = {
        receiverDrops,
        status: (reviewHours > 0 && enableVetoes) ? 'accepted' : 'accepted_immediate',
        acceptedDate: Timestamp.fromDate(simulatedDate),
        processDeadline: Timestamp.fromDate(processDeadline),
        vetoes: []
      };

      transaction.update(tradeRef, updates);
      console.log(`Trade accepted. Review window: ${reviewHours} hours (Vetoes enabled: ${enableVetoes}).`);
    } else {
      transaction.update(tradeRef, {
        status: 'rejected'
      });
      console.log("Trade proposal rejected.");
    }
  });

  try {
    const teamsSnap = await getDocs(collection(db, `fantasy_leagues/${leagueId}/teams`));
    const teamsMap = {};
    teamsSnap.forEach(tDoc => teamsMap[tDoc.id] = { id: tDoc.id, ...tDoc.data() });
    const tradeSnap = await getDoc(tradeRef);
    if (response === 'accept' && tradeSnap.exists()) {
      await notifyTradeEvent('accepted', leagueId, { tradeId, ...tradeSnap.data() }, {
        proposerTeamId: tradeSnap.data().proposerTeamId,
        receiverTeamId: tradeSnap.data().receiverTeamId,
        teamsMap
      });

      const status = tradeSnap.data().status;
      if (status === 'accepted_immediate') {
        await processAcceptedTrades(leagueId);
      }
    }
  } catch (nErr) {
    console.error("Trade acceptance notification error:", nErr);
  }
}

/**
 * Allows a non-involved league manager to cast a veto vote against an accepted trade.
 */
export async function vetoTrade(leagueId, tradeId, userId) {
  const tradeRef = doc(db, `fantasy_leagues/${leagueId}/trades`, tradeId);
  const leagueRef = doc(db, "fantasy_leagues", leagueId);

  await runTransaction(db, async (transaction) => {
    const tradeSnap = await transaction.get(tradeRef);
    const leagueSnap = await transaction.get(leagueRef);
    if (!tradeSnap.exists() || !leagueSnap.exists()) {
      throw new Error("Trade or league not found.");
    }

    const tradeData = tradeSnap.data();
    const tradeSettings = leagueSnap.data().tradeSettings || { vetoThreshold: 3 };
    const vetoThreshold = Number(tradeSettings.vetoThreshold ?? 3);

    if (tradeData.status !== 'accepted') {
      throw new Error("Only trades currently under review can be vetoed.");
    }

    const proposerTeamRef = doc(db, `fantasy_leagues/${leagueId}/teams`, tradeData.proposerTeamId);
    const receiverTeamRef = doc(db, `fantasy_leagues/${leagueId}/teams`, tradeData.receiverTeamId);
    const pSnap = await transaction.get(proposerTeamRef);
    const rSnap = await transaction.get(receiverTeamRef);

    if ((pSnap.exists() && pSnap.data().ownerId === userId) || (rSnap.exists() && rSnap.data().ownerId === userId)) {
      throw new Error("You cannot veto a trade involving your own team.");
    }

    const vetoes = new Set(tradeData.vetoes || []);
    if (vetoes.has(userId)) {
      throw new Error("You have already cast a veto vote for this trade.");
    }

    vetoes.add(userId);
    const updatedVetoes = Array.from(vetoes);

    const isVetoed = updatedVetoes.length >= vetoThreshold;

    transaction.update(tradeRef, {
      vetoes: updatedVetoes,
      status: isVetoed ? 'vetoed' : 'accepted'
    });

    console.log(`Veto vote cast by user ${userId}. Total vetoes: ${updatedVetoes.length}/${vetoThreshold}`);
  });
}

/**
 * Cancels an outgoing trade proposal.
 */
export async function cancelTradeProposal(leagueId, tradeId, userId) {
  const tradeRef = doc(db, `fantasy_leagues/${leagueId}/trades`, tradeId);
  await runTransaction(db, async (transaction) => {
    const tradeSnap = await transaction.get(tradeRef);
    if (!tradeSnap.exists()) {
      throw new Error("Trade proposal not found.");
    }
    const tradeData = tradeSnap.data();
    const proposerTeamRef = doc(db, `fantasy_leagues/${leagueId}/teams`, tradeData.proposerTeamId);
    const proposerSnap = await transaction.get(proposerTeamRef);
    
    if (!proposerSnap.exists() || proposerSnap.data().ownerId !== userId) {
      throw new Error("Unauthorized: Only the proposer co-owner can cancel this proposal.");
    }

    if (tradeData.status !== 'pending') {
      throw new Error(`Only pending trade proposals can be cancelled. Status: ${tradeData.status}`);
    }

    transaction.update(tradeRef, { status: 'cancelled' });
  });
}

/**
 * Cancels a pending waiver claim.
 */
export async function cancelWaiverClaim(leagueId, teamId, userId, playerId) {
  const teamRef = doc(db, `fantasy_leagues/${leagueId}/teams`, teamId);
  const claimId = `${teamId}_${playerId}`;

  await runTransaction(db, async (transaction) => {
    const teamSnap = await transaction.get(teamRef);
    if (!teamSnap.exists() || teamSnap.data().ownerId !== userId) {
      throw new Error("Unauthorized: You do not own this team.");
    }

    const docSnap = await transaction.get(doc(db, `fantasy_leagues/${leagueId}/waiver_claims`, claimId));
    if (docSnap.exists()) {
      transaction.delete(doc(db, `fantasy_leagues/${leagueId}/waiver_claims`, claimId));
    }
  });
}

/**
 * Processes all accepted trades that have completed their review period.
 * Validates veto counts, asset ownership, designated drop players, and resulting roster limits.
 */
export async function processAcceptedTrades(leagueId) {
  const simulatedDate = await getSimulatedSystemDate();
  const leagueRef = doc(db, "fantasy_leagues", leagueId);
  const leagueSnap = await getDoc(leagueRef);
  if (!leagueSnap.exists()) return;

  const leagueData = leagueSnap.data();
  const tradeSettings = leagueData.tradeSettings || { vetoThreshold: 3 };
  const vetoThreshold = Number(tradeSettings.vetoThreshold ?? 3);
  const undroppableList = new Set(leagueData.undroppable_players || []);

  const rosterSettings = leagueData.rosterSettings || { bench: 4, forwards: { starters: 6 }, defense: { starters: 4 }, goalies: { starters: 1 } };
  const maxRosterSize = (rosterSettings.bench ?? 4) + 
                        (rosterSettings.forwards?.starters ?? 6) + 
                        (rosterSettings.defense?.starters ?? 4) + 
                        (rosterSettings.goalies?.starters ?? 1);

  const tradesSnap = await getDocs(collection(db, `fantasy_leagues/${leagueId}/trades`));

  const eligibleTrades = [];
  tradesSnap.forEach(tDoc => {
    const data = tDoc.data();
    const isAccepted = data.status === 'accepted' || data.status === 'accepted_immediate';
    const isExpiredDeadline = data.processDeadline ? data.processDeadline.toDate() <= simulatedDate : true;
    if (isAccepted && (isExpiredDeadline || data.status === 'accepted_immediate')) {
      eligibleTrades.push(data);
    }
  });

  if (eligibleTrades.length === 0) {
    console.log("No pending accepted trades ready to process.");
    return;
  }

  for (const trade of eligibleTrades) {
    const tradeRef = doc(db, `fantasy_leagues/${leagueId}/trades`, trade.tradeId);
    const teamProposerRef = doc(db, `fantasy_leagues/${leagueId}/teams`, trade.proposerTeamId);
    const teamReceiverRef = doc(db, `fantasy_leagues/${leagueId}/teams`, trade.receiverTeamId);

    await runTransaction(db, async (transaction) => {
      // 1. Check veto threshold
      const vetoes = trade.vetoes || [];
      if (vetoes.length >= vetoThreshold) {
        transaction.update(tradeRef, { status: 'vetoed' });
        console.log(`Trade ${trade.tradeId} vetoed: Veto threshold of ${vetoThreshold} reached.`);
        return;
      }

      const proposerSnap = await transaction.get(teamProposerRef);
      const receiverSnap = await transaction.get(teamReceiverRef);

      if (!proposerSnap.exists() || !receiverSnap.exists()) {
        transaction.update(tradeRef, { status: 'voided' });
        console.log(`Trade ${trade.tradeId} voided: Team no longer exists.`);
        return;
      }

      const pData = proposerSnap.data();
      const rData = receiverSnap.data();

      let pRoster = [...(pData.players || [])];
      let rRoster = [...(rData.players || [])];

      const proposerSends = trade.proposerSends || [];
      const receiverSends = trade.receiverSends || [];
      const proposerDrops = trade.proposerDrops || [];
      const receiverDrops = trade.receiverDrops || [];

      // 2. Verify all traded assets are still owned
      const hasAllProposerAssets = proposerSends.every(pId => pRoster.includes(pId));
      const hasAllReceiverAssets = receiverSends.every(pId => rRoster.includes(pId));

      if (!hasAllProposerAssets || !hasAllReceiverAssets) {
        transaction.update(tradeRef, { status: 'voided' });
        console.log(`Trade ${trade.tradeId} voided: Traded assets no longer owned by respective teams.`);
        return;
      }

      // 3. Verify drops if specified
      for (const dId of proposerDrops) {
        if (!pRoster.includes(dId) || undroppableList.has(dId)) {
          transaction.update(tradeRef, { status: 'voided' });
          console.log(`Trade ${trade.tradeId} voided: Proposer drop player ${dId} is invalid or undroppable.`);
          return;
        }
      }
      for (const dId of receiverDrops) {
        if (!rRoster.includes(dId) || undroppableList.has(dId)) {
          transaction.update(tradeRef, { status: 'voided' });
          console.log(`Trade ${trade.tradeId} voided: Receiver drop player ${dId} is invalid or undroppable.`);
          return;
        }
      }

      // 4. Calculate resulting roster sizes
      let finalPRoster = pRoster.filter(id => !proposerSends.includes(id) && !proposerDrops.includes(id)).concat(receiverSends);
      let finalRRoster = rRoster.filter(id => !receiverSends.includes(id) && !receiverDrops.includes(id)).concat(proposerSends);

      if (finalPRoster.length > maxRosterSize || finalRRoster.length > maxRosterSize) {
        transaction.update(tradeRef, { status: 'voided' });
        console.log(`Trade ${trade.tradeId} voided: Resulting roster size exceeds max limit of ${maxRosterSize}.`);
        return;
      }

      // 5. Execute atomic swaps & drops
      transaction.update(teamProposerRef, { players: finalPRoster });
      transaction.update(teamReceiverRef, { players: finalRRoster });
      transaction.update(tradeRef, { status: 'processed' });

      // Place any dropped players on waivers for 48 hours
      const allDrops = [...proposerDrops, ...receiverDrops];
      for (const dropId of allDrops) {
        const nextWaiverDeadline = new Date(simulatedDate.getTime() + 48 * 60 * 60 * 1000);
        const dropWaiverRef = doc(db, `fantasy_leagues/${leagueId}/waivers`, dropId);
        transaction.set(dropWaiverRef, {
          playerId: dropId,
          waiverDeadline: Timestamp.fromDate(nextWaiverDeadline),
          createdAt: Timestamp.fromDate(simulatedDate)
        });
      }

      console.log(`Trade ${trade.tradeId} processed successfully! Rosters updated.`);
    });
  }
}

/**
 * securely moves a player between the active and bench arrays.
 */
export async function moveRosterPlayer(leagueId, teamId, playerId, target, rosterSettings) {
  const teamRef = doc(db, `fantasy_leagues/${leagueId}/teams`, teamId);

  await runTransaction(db, async (transaction) => {
    const snap = await transaction.get(teamRef);
    if (!snap.exists()) {
      throw new Error("Team not found.");
    }
    const data = snap.data();
    let activePlayers = data.activePlayers || [];
    let benchPlayers = data.benchPlayers || [];
    
    // Remove from both to avoid duplicates
    activePlayers = activePlayers.filter(id => id !== playerId);
    benchPlayers = benchPlayers.filter(id => id !== playerId);

    if (target === 'active') {
      // Validate positional limit before moving to active
      const playerRef = doc(db, "pwhl_players", playerId);
      const playerSnap = await transaction.get(playerRef);
      let playerPos = 'F';
      if (playerSnap.exists()) {
        playerPos = normalizePosition(playerSnap.data().position);
      } else {
        const numId = parseInt(String(playerId).replace(/^\D+/g, ''), 10);
        if (!isNaN(numId)) {
          if (numId >= 12 && numId <= 14) playerPos = "G";
          else if (numId >= 8 && numId <= 11) playerPos = "D";
        }
      }

      let activeCount = 0;
      for (const pId of activePlayers) {
        const pRef = doc(db, "pwhl_players", pId);
        const pSnap = await transaction.get(pRef);
        let pPos = 'F';
        if (pSnap.exists()) {
          pPos = normalizePosition(pSnap.data().position);
        } else {
          const numId = parseInt(String(pId).replace(/^\D+/g, ''), 10);
          if (!isNaN(numId)) {
            if (numId >= 12 && numId <= 14) pPos = "G";
            else if (numId >= 8 && numId <= 11) pPos = "D";
          }
        }
        if (pPos === playerPos) {
          activeCount++;
        }
      }

      const limit = playerPos === 'F' ? (rosterSettings.forwards?.starters ?? 6) :
                    playerPos === 'D' ? (rosterSettings.defense?.starters ?? 4) :
                    (rosterSettings.goalies?.starters ?? 1);

      if (activeCount >= limit) {
        throw new Error(`Cannot add player to active roster. Active limit reached for position ${playerPos}.`);
      }
      activePlayers.push(playerId);
    } else {
      benchPlayers.push(playerId);
    }

    transaction.update(teamRef, { activePlayers, benchPlayers });
  });
}

/**
 * Helper to format a local date string (YYYY-MM-DD)
 */
export function getLocalDateStr(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Timezone-safe helper that formats an ISO date string or Date object
 * to a YYYY-MM-DD string in America/Los_Angeles (Pacific Time) timezone.
 */
export function getPSTDateStr(date) {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  try {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(d);
  } catch {
    const s = typeof date === 'string' ? date : date.toISOString();
    return s.split('T')[0].split(' ')[0];
  }
}

/**
 * Atomic transaction to save daily lineup for a team.
 * Enforces roster rules and time-based slot locking.
 */
export async function saveDailyLineup(leagueId, teamId, dateStr, activeLineup, bench) {
  const leagueRef = doc(db, "fantasy_leagues", leagueId);
  const teamRef = doc(db, `fantasy_leagues/${leagueId}/teams`, teamId);
  const dailyLineupRef = doc(db, `fantasy_leagues/${leagueId}/teams/${teamId}/daily_lineups`, dateStr);

  const simSnap = await getDoc(doc(db, "admin_settings", "simulation_state"));
  let simDateStr = "";
  let simDateObj = new Date();
  if (simSnap.exists()) {
    const simData = simSnap.data();
    if (simData.testModeActive === true && simData.current_simulated_date) {
      simDateStr = simData.current_simulated_date.split('T')[0];
      simDateObj = simData.current_simulated_date.includes('T')
        ? new Date(simData.current_simulated_date)
        : new Date(`${simData.current_simulated_date}T08:00:00-08:00`);
    }
  }
  if (!simDateStr) {
    simDateStr = getLocalDateStr(new Date());
    simDateObj = new Date();
  }

  // Reject if dateStr is in the past
  if (dateStr < simDateStr) {
    throw new Error("Cannot modify a roster lineup for a past date.");
  }

  // Fetch games for dateStr outside the transaction
  const gamesSnap = await getDocs(collection(db, "pwhl_games"));
  const dailyGames = gamesSnap.docs.map(d => d.data()).filter(g => {
    const gDateStr = g.date_played || g.date;
    if (!gDateStr) return false;
    return (gDateStr || '').split('T')[0].split(' ')[0] === dateStr;
  });

  await runTransaction(db, async (transaction) => {
    const leagueSnap = await transaction.get(leagueRef);
    const teamSnap = await transaction.get(teamRef);

    if (!leagueSnap.exists() || !teamSnap.exists()) {
      throw new Error("League or team not found.");
    }

    const teamData = teamSnap.data();
    const ownedPlayers = (teamData.players || []).map(p => String(typeof p === 'object' && p !== null ? (p.id || p.player_id || p) : p));

    // Validate that all players in activeLineup and bench are owned by this team
    const newActiveIds = Object.values(activeLineup).filter(Boolean).map(String);
    const newBenchIds = bench.filter(Boolean).map(String);

    for (const pId of [...newActiveIds, ...newBenchIds]) {
      if (!ownedPlayers.includes(pId)) {
        throw new Error(`Player ${pId} is not on your master franchise roster.`);
      }
    }

    const seasonId = leagueSnap.data().season_id || "1";
    // Load all owned player documents to check positions & team IDs
    const playerSnaps = await Promise.all(
      ownedPlayers.map(pId => transaction.get(doc(db, "pwhl_players", `${seasonId}_${pId}`)))
    );

    const playersInfo = {};
    ownedPlayers.forEach((pId, idx) => {
      const pSnap = playerSnaps[idx];
      let pos = 'F';
      let teamId = '';
      let name = pId;
      if (pSnap && pSnap.exists()) {
        const pData = pSnap.data();
        pos = normalizePosition(pData.position);
        teamId = String(pData.current_team_id || pData.team_id || '');
        name = pData.name || `${pData.first_name || ''} ${pData.last_name || ''}`.trim() || pId;
      } else {
        const numId = parseInt(String(pId).replace(/^\D+/g, ''), 10);
        if (!isNaN(numId)) {
          if (numId >= 12 && numId <= 14) pos = "G";
          else if (numId >= 8 && numId <= 11) pos = "D";
        }
      }
      playersInfo[String(pId)] = { pos, teamId, name };
    });

    // Validate active lineup limits
    const rosterSettings = leagueSnap.data().rosterSettings || { bench: 4, forwards: { starters: 6 }, defense: { starters: 4 }, goalies: { starters: 1 } };
    const fLimit = rosterSettings.forwards?.starters ?? 6;
    const dLimit = rosterSettings.defense?.starters ?? 4;
    const gLimit = rosterSettings.goalies?.starters ?? 1;

    let fCount = 0, dCount = 0, gCount = 0;
    for (const [slot, pId] of Object.entries(activeLineup)) {
      if (!pId) continue;
      const info = playersInfo[String(pId)];
      if (!info) continue;
      if (slot.startsWith('F')) fCount++;
      else if (slot.startsWith('D')) dCount++;
      else if (slot.startsWith('G')) gCount++;

      // Verify player fits the slot position
      if (slot.startsWith('F') && info.pos !== 'F') throw new Error(`Cannot place non-Forward ${info.name} in slot ${slot}.`);
      if (slot.startsWith('D') && info.pos !== 'D') throw new Error(`Cannot place non-Defenseman ${info.name} in slot ${slot}.`);
      if (slot.startsWith('G') && info.pos !== 'G') throw new Error(`Cannot place non-Goalie ${info.name} in slot ${slot}.`);
    }

    if (fCount > fLimit) throw new Error(`Forwards limit exceeded. Max active forwards: ${fLimit}.`);
    if (dCount > dLimit) throw new Error(`Defensemen limit exceeded. Max active defensemen: ${dLimit}.`);
    if (gCount > gLimit) throw new Error(`Goalies limit exceeded. Max active goalies: ${gLimit}.`);

    // Fetch existing lineup
    const dailyLineupSnap = await transaction.get(dailyLineupRef);
    let existingActive = {};
    let existingBench = [];

    if (dailyLineupSnap.exists()) {
      const dData = dailyLineupSnap.data();
      existingActive = dData.activeLineup || {};
      existingBench = dData.bench || [];
    } else {
      // Fallback: build default lineup
      let fc = 0, dc = 0, gc = 0;
      const activeIds = (teamData.activePlayers || []).map(String);
      const benchIds = (teamData.benchPlayers || []).map(String);

      activeIds.forEach(pId => {
        const info = playersInfo[String(pId)];
        if (!info) return;
        if (info.pos === 'F' && fc < fLimit) { fc++; existingActive[`F${fc}`] = pId; }
        else if (info.pos === 'D' && dc < dLimit) { dc++; existingActive[`D${dc}`] = pId; }
        else if (info.pos === 'G' && gc < gLimit) { gc++; existingActive[`G${gc}`] = pId; }
        else { existingBench.push(pId); }
      });
      benchIds.forEach(pId => {
        existingBench.push(pId);
      });
    }

    // Detect moved players
    const movedPlayerIds = new Set();
    const allPlayerIds = new Set([...ownedPlayers]);

    allPlayerIds.forEach(pId => {
      let currentSlot = 'none';
      if (existingBench.includes(pId)) {
        currentSlot = 'bench';
      } else {
        const slotKey = Object.keys(existingActive).find(k => existingActive[k] === pId);
        if (slotKey) currentSlot = slotKey;
      }

      let newSlot = 'none';
      if (newBenchIds.includes(pId)) {
        newSlot = 'bench';
      } else {
        const slotKey = Object.keys(activeLineup).find(k => activeLineup[k] === pId);
        if (slotKey) newSlot = slotKey;
      }

      if (currentSlot !== newSlot) {
        movedPlayerIds.add(pId);
      }
    });

    // Enforce lock checking for current day writes
    if (dateStr === simDateStr && movedPlayerIds.size > 0) {
      for (const pId of movedPlayerIds) {
        const info = playersInfo[pId];
        if (!info) continue;

        // Find game for player's team today
        const playerGame = dailyGames.find(g => {
          return String(g.home_team) === info.teamId || String(g.visiting_team) === info.teamId;
        });

        if (playerGame) {
          const gameStart = parseDateSafe(playerGame.GameDateISO8601 || playerGame.date_time_played || playerGame.date_played || playerGame.date);
          if (simDateObj >= gameStart) {
            throw new Error(`Cannot swap ${info.name}. Their game has already started.`);
          }
        }
      }
    }

    // If validation passes, write the lineup
    transaction.set(dailyLineupRef, {
      date: dateStr,
      activeLineup,
      bench: newBenchIds,
      source: "user"
    });
  });
}

/**
 * Fetches a team's lineup for a given day, falling back to default if document not found.
 */
export async function getDailyLineup(leagueId, teamId, dateStr) {
  const teamRef = doc(db, `fantasy_leagues/${leagueId}/teams`, teamId);
  const dailyLineupRef = doc(db, `fantasy_leagues/${leagueId}/teams/${teamId}/daily_lineups`, dateStr);

  const teamSnap = await getDoc(teamRef);
  if (!teamSnap.exists()) {
    throw new Error("Team not found.");
  }
  const teamData = teamSnap.data();

  const dailyLineupSnap = await getDoc(dailyLineupRef);
  if (dailyLineupSnap.exists()) {
    const data = dailyLineupSnap.data();
    const activeLineup = data.activeLineup || {};
    const bench = data.bench || [];

    // Load league to get seasonId
    const leagueRef = doc(db, "fantasy_leagues", leagueId);
    let seasonId = "1";
    try {
      const leagueSnap = await getDoc(leagueRef);
      if (leagueSnap.exists()) {
        seasonId = leagueSnap.data().season_id || "1";
      }
    } catch (err) {
      console.warn("[getDailyLineup] Failed to fetch league details, defaulting to season 1:", err);
    }

    // Fetch player positions in parallel with try-catch blocks to prevent permission denied crashes
    const activeEntries = Object.entries(activeLineup).filter(([_, pId]) => !!pId);
    const playerPositions = {};
    
    await Promise.all(
      activeEntries.map(async ([_, pId]) => {
        let pos = 'F';
        try {
          const pSnap = await getDoc(doc(db, "pwhl_players", `${seasonId}_${pId}`));
          if (pSnap.exists()) {
            pos = normalizePosition(pSnap.data().position);
          } else {
            const numId = parseInt(String(pId).replace(/^\D+/g, ''), 10);
            if (!isNaN(numId)) {
              if (numId >= 12 && numId <= 14) pos = "G";
              else if (numId >= 8 && numId <= 11) pos = "D";
            }
          }
        } catch (err) {
          console.warn(`[getDailyLineup] Failed to fetch player ${pId} details, falling back:`, err);
          const numId = parseInt(String(pId).replace(/^\D+/g, ''), 10);
          if (!isNaN(numId)) {
            if (numId >= 12 && numId <= 14) pos = "G";
            else if (numId >= 8 && numId <= 11) pos = "D";
          }
        }
        playerPositions[String(pId)] = pos;
      })
    );

    let needsUpdate = false;
    const cleanedActive = {};
    const cleanedBench = [...bench];

    for (const [slot, pId] of Object.entries(activeLineup)) {
      if (!pId) continue;
      const pos = playerPositions[String(pId)] || 'F';

      const isEligible = (slot.startsWith('F') && pos === 'F') ||
                         (slot.startsWith('D') && pos === 'D') ||
                         (slot.startsWith('G') && pos === 'G');

      if (isEligible) {
        cleanedActive[slot] = pId;
      } else {
        needsUpdate = true;
        if (!cleanedBench.includes(String(pId))) {
          cleanedBench.push(String(pId));
        }
      }
    }

    if (needsUpdate) {
      console.log(`[Roster Migration] Stale lineup detected for team ${teamId} on ${dateStr}. Moving ineligible players to bench.`);
      try {
        await setDoc(dailyLineupRef, {
          activeLineup: cleanedActive,
          bench: cleanedBench
        }, { merge: true });
      } catch (err) {
        console.warn("Failed to auto-update daily lineup:", err);
      }
      return {
        date: dateStr,
        activeLineup: cleanedActive,
        bench: cleanedBench
      };
    }

    return {
      date: dateStr,
      activeLineup,
      bench
    };
  }

  // Fallback: build default lineup
  const leagueRef = doc(db, "fantasy_leagues", leagueId);
  const leagueSnap = await getDoc(leagueRef);
  const rosterSettings = leagueSnap.exists() ? (leagueSnap.data().rosterSettings || {}) : {};
  const fLimit = rosterSettings.forwards?.starters ?? 6;
  const dLimit = rosterSettings.defense?.starters ?? 4;
  const gLimit = rosterSettings.goalies?.starters ?? 1;

  const activeIds = (teamData.activePlayers || []).map(String);
  const benchIds = (teamData.benchPlayers || []).map(String);

  const seasonId = leagueSnap.exists() ? (leagueSnap.data().season_id || "1") : "1";
  // Fetch all owned player positions to build mapping
  const ownedPlayers = (teamData.players || []).map(p => String(typeof p === 'object' && p !== null ? (p.id || p.player_id || p) : p));
  const playersInfo = {};
  for (const pId of ownedPlayers) {
    const pSnap = await getDoc(doc(db, "pwhl_players", `${seasonId}_${pId}`));
    let pos = 'F';
    if (pSnap.exists()) {
      pos = normalizePosition(pSnap.data().position);
    } else {
      const numId = parseInt(String(pId).replace(/^\D+/g, ''), 10);
      if (!isNaN(numId)) {
        if (numId >= 12 && numId <= 14) pos = "G";
        else if (numId >= 8 && numId <= 11) pos = "D";
      }
    }
    playersInfo[String(pId)] = pos;
  }

  const activeLineup = {};
  const bench = [];
  let fc = 0, dc = 0, gc = 0;

  activeIds.forEach(pId => {
    const pos = playersInfo[String(pId)] || 'F';
    if (pos === 'F' && fc < fLimit) { fc++; activeLineup[`F${fc}`] = pId; }
    else if (pos === 'D' && dc < dLimit) { dc++; activeLineup[`D${dc}`] = pId; }
    else if (pos === 'G' && gc < gLimit) { gc++; activeLineup[`G${gc}`] = pId; }
    else { bench.push(pId); }
  });

  benchIds.forEach(pId => {
    bench.push(pId);
  });

  return {
    date: dateStr,
    activeLineup,
    bench
  };
}
