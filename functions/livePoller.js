/**
 * Live Game Poller — every 5 minutes.
 *
 * On a day without PWHL games it reads one document (live_state/current) and stops.
 * On a game day it fetches each game from 30 min before puck drop until Final, then
 * at the post-game check times, and rebuilds that day's fantasy points whenever the
 * stats change. All logic lives in liveStats.js#runLivePoll.
 *
 * Simulations never use this path (they replay historical data on their own clock).
 */
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { getFirestore } = require("firebase-admin/firestore");
const { runLivePoll } = require("./liveStats");

exports.liveGamePoller = onSchedule(
  { schedule: "every 5 minutes", region: "us-central1", timeoutSeconds: 240 },
  async () => {
    const outcome = await runLivePoll(getFirestore(), Date.now());
    console.log(`[LivePoller] ${outcome}`);
    return null;
  });
