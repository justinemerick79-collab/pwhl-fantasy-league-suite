import { db } from '../firebase';
import { 
  collection, 
  doc, 
  runTransaction,
  serverTimestamp,
  query,
  where,
  getDocs,
  Timestamp
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
