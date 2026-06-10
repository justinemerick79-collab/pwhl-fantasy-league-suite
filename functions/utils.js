const admin = require("firebase-admin");

/**
 * Central system clock utility.
 * 
 * Resolves the "current" date for the system, supporting:
 * 1. Per-league simulation dates (new architecture)
 * 2. Global simulation state (backward compatibility)
 * 3. Standard Date.now() (production)
 * 
 * Priority order:
 *   1. If leagueId is provided and the league has isSimulation=true + simulatedDate → use it
 *   2. If admin_settings/simulation_state has testModeActive=true → use global simulated date
 *   3. Otherwise → Date.now()
 * 
 * @param {string} [leagueId] - Optional league ID for per-league simulation
 * @returns {Promise<number>} Epoch milliseconds of the current system date.
 */
async function getSystemDate(leagueId = null) {
  const db = admin.firestore();

  // 1. Per-league simulation date (new architecture)
  if (leagueId) {
    try {
      const leagueSnap = await db.collection("fantasy_leagues").doc(leagueId).get();
      if (leagueSnap.exists) {
        const data = leagueSnap.data();
        if (data.isSimulation === true && data.simulatedDate) {
          const dateObj = new Date(data.simulatedDate);
          if (!isNaN(dateObj.getTime())) {
            return dateObj.getTime();
          }
        }
      }
    } catch (err) {
      console.error("Error fetching per-league simulation date:", err);
    }
  }

  // 2. Global simulation state (backward compatibility)
  try {
    const simRef = db.collection("admin_settings").doc("simulation_state");
    const simSnap = await simRef.get();
    if (simSnap.exists) {
      const data = simSnap.data();
      if (data.testModeActive === true && data.current_simulated_date) {
        const dateObj = new Date(data.current_simulated_date);
        if (!isNaN(dateObj.getTime())) {
          return dateObj.getTime();
        }
      }
    }
  } catch (err) {
    console.error("Error fetching simulation clock:", err);
  }

  // 3. Standard clock
  return Date.now();
}

module.exports = {
  getSystemDate
};
