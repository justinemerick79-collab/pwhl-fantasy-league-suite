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
  setDoc
} from 'firebase/firestore';

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

    transaction.update(leagueRef, {
      members: updatedMembers,
      userIds: updatedMembers, // maintain backwards compatibility
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
    draftOrder.forEach(uid => {
      activeRosters[uid] = [];
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
 */
export async function submitDraftPick(leagueId, userId, playerId, isAutoPick = false) {
  const leagueRef = doc(db, "fantasy_leagues", leagueId);
  const draftStateRef = doc(db, `fantasy_leagues/${leagueId}/draft`, "state");

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
    const maxRounds = (rosterSettings.bench ?? 4) + 
                       (rosterSettings.forwards?.starters ?? 6) + 
                       (rosterSettings.defense?.starters ?? 4) + 
                       (rosterSettings.goalies?.starters ?? 1);
    
    const totalPicks = maxRounds * N;

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

    transaction.update(draftStateRef, {
      status: nextStatus,
      currentRound: nextRound,
      currentPickIndex: nextPickIndex,
      currentTeamOnClock: nextTeamOnClock || pickerUserId,
      pickDeadline: nextDeadline,
      picks: updatedPicks,
      activeRosters: activeRosters
    });

    if (nextStatus === 'completed') {
      transaction.update(leagueRef, {
        status: 'active' // Draft is complete, league is now active!
      });
    }
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
    const envSnap = await getDoc(doc(db, "admin_settings", "environment"));
    if (envSnap.exists()) {
      const envData = envSnap.data();
      if (envData.time_travel_mode === true) {
        const rawDate = envData.simulated_date || envData.current_system_date;
        if (rawDate) {
          return new Date(rawDate);
        }
      }
    }
  } catch (err) {
    console.error("Error reading admin_settings/environment:", err);
  }

  try {
    const ttSnap = await getDoc(doc(db, "app_settings", "time_travel"));
    if (ttSnap.exists()) {
      const ttData = ttSnap.data();
      if (ttData.enabled && ttData.date) {
        return new Date(`${ttData.date}T08:00:00-08:00`);
      }
    }
  } catch (err) {
    console.error("Error reading app_settings/time_travel:", err);
  }

  return new Date();
}

/**
 * Performs an atomic Add/Drop Free Agency swap.
 * Validates roster limits and places dropped player on a 48-hour waiver.
 */
export async function submitAddDrop(leagueId, teamId, userId, addPlayerId, dropPlayerId) {
  const leagueRef = doc(db, "fantasy_leagues", leagueId);
  const teamRef = doc(db, `fantasy_leagues/${leagueId}/teams`, teamId);

  // We fetch simulated time outside transaction (calls inside transaction must be synchronous/reads first)
  const simulatedDate = await getSimulatedSystemDate();

  await runTransaction(db, async (transaction) => {
    const leagueSnap = await transaction.get(leagueRef);
    const teamSnap = await transaction.get(teamRef);

    if (!leagueSnap.exists() || !teamSnap.exists()) {
      throw new Error("League or team not found.");
    }

    const teamData = teamSnap.data();
    if (teamData.ownerId !== userId) {
      throw new Error("Unauthorized: You do not own this team.");
    }

    const currentRoster = teamData.players || [];
    
    // Verify drop player is owned
    if (dropPlayerId && !currentRoster.includes(dropPlayerId)) {
      throw new Error(`Player ${dropPlayerId} is not on your roster.`);
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
    const rosterSettings = leagueSnap.data().rosterSettings || { bench: 4, forwards: { starters: 6 }, defense: { starters: 4 }, goalies: { starters: 1 } };
    const maxRosterSize = (rosterSettings.bench ?? 4) + 
                          (rosterSettings.forwards?.starters ?? 6) + 
                          (rosterSettings.defense?.starters ?? 4) + 
                          (rosterSettings.goalies?.starters ?? 1);

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
  const teamRef = doc(db, `fantasy_leagues/${leagueId}/teams`, teamId);
  const waiverRef = doc(db, `fantasy_leagues/${leagueId}/waivers`, playerId);
  
  const simulatedDate = await getSimulatedSystemDate();

  await runTransaction(db, async (transaction) => {
    const teamSnap = await transaction.get(teamRef);
    const waiverSnap = await transaction.get(waiverRef);

    if (!teamSnap.exists() || !waiverSnap.exists()) {
      throw new Error("Team or waiver player not found.");
    }

    const teamData = teamSnap.data();
    if (teamData.ownerId !== userId) {
      throw new Error("Unauthorized: You do not own this team.");
    }

    if (dropPlayerId && !(teamData.players || []).includes(dropPlayerId)) {
      throw new Error(`Designated drop player ${dropPlayerId} is not on your roster.`);
    }

    const claimId = `${teamId}_${playerId}`;
    const claimRef = doc(db, `fantasy_leagues/${leagueId}/waiver_claims`, claimId);

    transaction.set(claimRef, {
      teamId,
      userId,
      playerId,
      dropPlayerId,
      createdAt: Timestamp.fromDate(simulatedDate)
    });
  });
}

/**
 * Processes all expired waiver claims based on the league's rolling waiver priority queue.
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
        // No claims: player becomes free agent
        transaction.delete(waiverDocRef);
        console.log(`Waiver expired for player ${playerId}. Player is now a Free Agent.`);
        continue;
      }

      // Find the winning claim based on the rolling waiver priority queue
      let winningClaim = null;
      let winningPriorityIndex = Infinity;

      claims.forEach(claim => {
        const priorityIndex = currentWaiverOrder.indexOf(claim.teamId);
        if (priorityIndex !== -1 && priorityIndex < winningPriorityIndex) {
          winningPriorityIndex = priorityIndex;
          winningClaim = claim;
        }
      });

      // If no claiming team is in the waiverOrder array, fallback to oldest claim
      if (!winningClaim && claims.length > 0) {
        winningClaim = claims[0];
      }

      if (winningClaim) {
        const winningTeamId = winningClaim.teamId;
        const dropPlayerId = winningClaim.dropPlayerId;

        const teamRef = doc(db, `fantasy_leagues/${leagueId}/teams`, winningTeamId);
        const teamSnap = await transaction.get(teamRef);

        if (teamSnap.exists()) {
          const teamData = teamSnap.data();
          let roster = teamData.players || [];

          // Perform atomic swap
          if (dropPlayerId) {
            roster = roster.filter(pid => pid !== dropPlayerId);
            
            // Generate a waiver document for the dropped player
            const nextWaiverDeadline = new Date(simulatedDate.getTime() + 48 * 60 * 60 * 1000);
            const dropWaiverRef = doc(db, `fantasy_leagues/${leagueId}/waivers`, dropPlayerId);
            transaction.set(dropWaiverRef, {
              playerId: dropPlayerId,
              droppedByTeamId: winningTeamId,
              waiverDeadline: Timestamp.fromDate(nextWaiverDeadline),
              createdAt: Timestamp.fromDate(simulatedDate)
            });
          }
          
          roster.push(playerId);

          // Update winning team roster
          transaction.update(teamRef, { players: roster });

          // Rotate priority: Move winning team to the bottom of the roll queue
          currentWaiverOrder = currentWaiverOrder.filter(id => id !== winningTeamId);
          currentWaiverOrder.push(winningTeamId);

          console.log(`Waiver Claim Successful! Player ${playerId} assigned to team ${winningTeamId}.`);
        }
      }

      // Cleanup processed waiver and delete claims
      transaction.delete(waiverDocRef);
      claims.forEach(claim => {
        const claimId = `${claim.teamId}_${playerId}`;
        transaction.delete(doc(db, `fantasy_leagues/${leagueId}/waiver_claims`, claimId));
      });
    }

    // Write updated rolling waiver order queue back to the league
    transaction.update(leagueRef, {
      waiverOrder: currentWaiverOrder
    });
  });
}

/**
 * Submits a trade proposal between two teams.
 */
export async function submitTradeProposal(leagueId, proposerTeamId, receiverTeamId, proposerSends, receiverSends) {
  const simulatedDate = await getSimulatedSystemDate();
  const tradeId = doc(collection(db, `fantasy_leagues/${leagueId}/trades`)).id;
  const tradeRef = doc(db, `fantasy_leagues/${leagueId}/trades`, tradeId);

  await setDoc(tradeRef, {
    tradeId,
    proposerTeamId,
    receiverTeamId,
    proposerSends,
    receiverSends,
    status: 'pending',
    proposalDate: Timestamp.fromDate(simulatedDate)
  });
  
  return tradeId;
}

/**
 * Responds to a trade proposal (Accept or Reject).
 */
export async function respondToTrade(leagueId, tradeId, userId, response) {
  const tradeRef = doc(db, `fantasy_leagues/${leagueId}/trades`, tradeId);
  const simulatedDate = await getSimulatedSystemDate();

  await runTransaction(db, async (transaction) => {
    const tradeSnap = await transaction.get(tradeRef);
    if (!tradeSnap.exists()) {
      throw new Error("Trade proposal not found.");
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
      const processDeadline = new Date(simulatedDate.getTime() + 24 * 60 * 60 * 1000); // 24-hour review
      transaction.update(tradeRef, {
        status: 'accepted',
        acceptedDate: Timestamp.fromDate(simulatedDate),
        processDeadline: Timestamp.fromDate(processDeadline)
      });
      console.log("Trade accepted. Moving to 24-hour veto review window.");
    } else {
      transaction.update(tradeRef, {
        status: 'rejected'
      });
      console.log("Trade proposal rejected.");
    }
  });
}

/**
 * Processes all accepted trades that have completed their 24-hour review period.
 */
export async function processAcceptedTrades(leagueId) {
  const simulatedDate = await getSimulatedSystemDate();
  const tradesSnap = await getDocs(collection(db, `fantasy_leagues/${leagueId}/trades`));

  const acceptedTrades = [];
  tradesSnap.forEach(tDoc => {
    const data = tDoc.data();
    if (data.status === 'accepted' && data.processDeadline.toDate() <= simulatedDate) {
      acceptedTrades.push(data);
    }
  });

  if (acceptedTrades.length === 0) {
    console.log("No pending accepted trades to process.");
    return;
  }

  for (const trade of acceptedTrades) {
    const tradeRef = doc(db, `fantasy_leagues/${leagueId}/trades`, trade.tradeId);
    const teamProposerRef = doc(db, `fantasy_leagues/${leagueId}/teams`, trade.proposerTeamId);
    const teamReceiverRef = doc(db, `fantasy_leagues/${leagueId}/teams`, trade.receiverTeamId);

    await runTransaction(db, async (transaction) => {
      const proposerSnap = await transaction.get(teamProposerRef);
      const receiverSnap = await transaction.get(teamReceiverRef);

      if (!proposerSnap.exists() || !receiverSnap.exists()) {
        throw new Error("Proposer or receiver team no longer exists.");
      }

      const pData = proposerSnap.data();
      const rData = receiverSnap.data();

      let pRoster = pData.players || [];
      let rRoster = rData.players || [];

      // Verify all assets are still owned by their respective teams
      const hasAllProposerAssets = trade.proposerSends.every(pId => pRoster.includes(pId));
      const hasAllReceiverAssets = trade.receiverSends.every(pId => rRoster.includes(pId));

      if (!hasAllProposerAssets || !hasAllReceiverAssets) {
        transaction.update(tradeRef, { status: 'voided' });
        console.log(`Trade ${trade.tradeId} voided due to missing assets.`);
        return;
      }

      // Perform exchange swaps
      pRoster = pRoster.filter(pid => !trade.proposerSends.includes(pid)).concat(trade.receiverSends);
      rRoster = rRoster.filter(pid => !trade.receiverSends.includes(pid)).concat(trade.proposerSends);

      transaction.update(teamProposerRef, { players: pRoster });
      transaction.update(teamReceiverRef, { players: rRoster });
      transaction.update(tradeRef, { status: 'processed' });

      console.log(`Trade ${trade.tradeId} processed successfully! Rosters updated.`);
    });
  }
}
