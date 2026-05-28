import { db } from '../firebase';
import { 
  collection, 
  doc, 
  writeBatch, 
  serverTimestamp, 
  getDoc,
  deleteDoc,
  arrayUnion,
  arrayRemove
} from 'firebase/firestore';

/**
 * Creates a new fantasy league.
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

  const batch = writeBatch(db);

  // 1. Create the League Document
  const leagueRef = doc(collection(db, "leagues"));
  const leagueData = {
    name: name,
    commissionerId: userId,
    maxTeams: maxTeams,
    userIds: [userId],
    status: 'active_not_full',
    createdAt: serverTimestamp()
  };
  batch.set(leagueRef, leagueData);

  // 2. Create the Commissioner's Team inside the league
  const teamRef = doc(collection(leagueRef, "teams"));
  const teamData = {
    ownerId: userId,
    teamName: teamName,
    joinedAt: serverTimestamp()
  };
  batch.set(teamRef, teamData);

  // Commit the batch
  await batch.commit();
  return leagueRef.id;
}

/**
 * Joins an existing fantasy league.
 * 
 * @param {string} leagueId - The ID of the league to join.
 * @param {string} userId - The UID of the user joining.
 * @param {string} teamName - The user's team name.
 */
export async function joinLeague(leagueId, userId, teamName) {
  const leagueRef = doc(db, "leagues", leagueId);
  
  // Read the league first to determine if it will become full
  const leagueSnap = await getDoc(leagueRef);
  
  if (!leagueSnap.exists()) {
    throw new Error("League does not exist.");
  }

  const leagueData = leagueSnap.data();

  if (leagueData.userIds.includes(userId)) {
    throw new Error("You are already in this league.");
  }

  if (leagueData.userIds.length >= leagueData.maxTeams) {
    throw new Error("This league is already full.");
  }

  const batch = writeBatch(db);

  // 1. Update the League userIds and potentially status
  const newUserIdsLength = leagueData.userIds.length + 1;
  const newStatus = (newUserIdsLength === leagueData.maxTeams) ? 'active_full' : 'active_not_full';

  batch.update(leagueRef, {
    userIds: arrayUnion(userId),
    status: newStatus
  });

  // 2. Create the User's Team
  const teamRef = doc(collection(leagueRef, "teams"));
  batch.set(teamRef, {
    ownerId: userId,
    teamName: teamName,
    joinedAt: serverTimestamp()
  });

  await batch.commit();
}

/**
 * Deletes an existing league (Commissioner only).
 * Note: Subcollections aren't automatically deleted by deleting the parent in Firestore.
 * In a real production app, a Cloud Function should recursively delete the subcollection.
 * For this client-side code, we will delete the parent document which renders it inaccessible.
 * 
 * @param {string} leagueId 
 */
export async function deleteLeague(leagueId) {
  const leagueRef = doc(db, "leagues", leagueId);
  await deleteDoc(leagueRef);
}

/**
 * Reassigns the ownership of a team to a new user (Commissioner only).
 * 
 * @param {string} leagueId 
 * @param {string} teamId 
 * @param {string} oldOwnerId 
 * @param {string} newOwnerId 
 */
export async function reassignTeamOwner(leagueId, teamId, oldOwnerId, newOwnerId) {
  const batch = writeBatch(db);

  const leagueRef = doc(db, "leagues", leagueId);
  batch.update(leagueRef, {
    userIds: arrayRemove(oldOwnerId)
  });
  batch.update(leagueRef, {
    userIds: arrayUnion(newOwnerId)
  });

  const teamRef = doc(db, `leagues/${leagueId}/teams`, teamId);
  batch.update(teamRef, {
    ownerId: newOwnerId
  });

  await batch.commit();
}
