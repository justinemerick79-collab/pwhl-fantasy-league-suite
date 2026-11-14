import { db } from '../firebase.js';
import { collection, doc, setDoc, addDoc, serverTimestamp } from 'firebase/firestore';

/**
 * Creates an in-app notification for a user and logs a simulated email dispatch.
 */
export async function createNotification(userId, title, message, type = 'info', metadata = {}) {
  if (!userId) return;
  try {
    const notifRef = collection(db, `users/${userId}/notifications`);
    await addDoc(notifRef, {
      userId,
      title,
      message,
      type,
      metadata,
      read: false,
      createdAt: serverTimestamp()
    });

    // Log simulated email dispatch
    console.log(`[EMAIL DISPATCH SIMULATION] 📧 Sending email to user ${userId}:
    Subject: ${title}
    Body: ${message}`);
  } catch (err) {
    console.error(`Failed to create notification for user ${userId}:`, err);
  }
}

/**
 * Dispatches trade notifications (Proposed, Accepted, Vetoed, Processed)
 * to involved team owners or all league members.
 */
export async function notifyTradeEvent(eventType, leagueId, tradeData, extraInfo = {}) {
  const { proposerTeamId, receiverTeamId, proposerSends, receiverSends, teamsMap = {}, userMap = {} } = extraInfo;

  const proposerOwnerId = teamsMap[proposerTeamId]?.ownerId;
  const receiverOwnerId = teamsMap[receiverTeamId]?.ownerId;

  const proposerTeamName = teamsMap[proposerTeamId]?.teamName || 'Proposer Team';
  const receiverTeamName = teamsMap[receiverTeamId]?.teamName || 'Receiver Team';

  if (eventType === 'proposed') {
    if (receiverOwnerId) {
      await createNotification(
        receiverOwnerId,
        `📥 New Trade Proposal from ${proposerTeamName}`,
        `${proposerTeamName} has proposed a trade with your team. Review the proposal in Waivers & Trades Central.`,
        'trade_proposal',
        { leagueId, tradeId: tradeData.tradeId }
      );
    }
  } else if (eventType === 'accepted') {
    // Notify proposer
    if (proposerOwnerId) {
      await createNotification(
        proposerOwnerId,
        `🤝 Trade Accepted by ${receiverTeamName}`,
        `Your trade proposal with ${receiverTeamName} was accepted and is now in the 48-hour veto review window.`,
        'trade_accepted',
        { leagueId, tradeId: tradeData.tradeId }
      );
    }
    // Notify all other league members if notifyAcceptedTrades is enabled
    Object.values(teamsMap).forEach(async (team) => {
      if (team.ownerId && team.ownerId !== proposerOwnerId && team.ownerId !== receiverOwnerId) {
        await createNotification(
          team.ownerId,
          `🔔 Trade Accepted in League: Review & Veto Period Active`,
          `A trade between ${proposerTeamName} and ${receiverTeamName} has been accepted. Review the details in Waivers & Trades Central.`,
          'trade_review',
          { leagueId, tradeId: tradeData.tradeId }
        );
      }
    });
  } else if (eventType === 'vetoed') {
    const message = `The trade between ${proposerTeamName} and ${receiverTeamName} was vetoed by league managers and will not execute.`;
    if (proposerOwnerId) await createNotification(proposerOwnerId, `❌ Trade Vetoed`, message, 'trade_vetoed');
    if (receiverOwnerId) await createNotification(receiverOwnerId, `❌ Trade Vetoed`, message, 'trade_vetoed');
  } else if (eventType === 'processed') {
    const message = `The trade between ${proposerTeamName} and ${receiverTeamName} has completed review and rosters have been updated!`;
    if (proposerOwnerId) await createNotification(proposerOwnerId, `✅ Trade Executed`, message, 'trade_executed');
    if (receiverOwnerId) await createNotification(receiverOwnerId, `✅ Trade Executed`, message, 'trade_executed');
  }
}
