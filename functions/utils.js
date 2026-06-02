const admin = require("firebase-admin");

/**
 * Central system clock utility.
 * If admin_settings/simulation_state has testModeActive: true, it returns the current_simulated_date.
 * Otherwise, it returns standard Date.now().
 * 
 * @returns {Promise<number>} Epoch milliseconds of the current system date.
 */
async function getSystemDate() {
  const db = admin.firestore();
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
  return Date.now();
}

module.exports = {
  getSystemDate
};
