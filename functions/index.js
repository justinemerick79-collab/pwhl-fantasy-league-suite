const functions = require("firebase-functions");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
const { Timestamp, FieldValue } = require("firebase-admin/firestore");
const { getSystemDate } = require("./utils");

admin.initializeApp();
const db = admin.firestore();

const API_KEY = '446521baf8c38984';
const CLIENT_CODE = 'pwhl';
const BASE_URL = 'https://lscluster.hockeytech.com/feed/index.php';

/**
 * Fetches JSON data from HockeyTech GC API
 */
async function fetchFromApi(params) {
  const url = new URL(BASE_URL);
  url.searchParams.append('key', API_KEY);
  url.searchParams.append('client_code', CLIENT_CODE);
  url.searchParams.append('fmt', 'json'); 
  
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.append(key, value);
  }

  const response = await fetch(url.toString());
  if (!response.ok) throw new Error(`HockeyTech API fetch failed: ${response.statusText}`);
  
  const text = await response.text();
  let jsonString = text;
  // Handle JSONP callback wrappers if present
  if (text.startsWith('typeof ') || text.indexOf('(') > -1) {
      const match = text.match(/^[^{]*({.*})[^}]*$/s);
      if (match) {
          jsonString = match[1];
      }
  }
  
  return JSON.parse(jsonString);
}

/**
 * Cloud Function running every 24 hours to sync Schedule and Player Stats.
 * Safely aggregates and chunks batch writes into sizes of 490 documents maximum.
 */
exports.syncDailyData = functions.pubsub
  .schedule("every 24 hours")
  .onRun(async (context) => {
    console.log("Daily scheduled ingestion started...");
    try {
      // 1. Fetch seasons to identify active seasons to sync
      const seasonsData = await fetchFromApi({ feed: 'modulekit', view: 'seasons' });
      const seasons = seasonsData?.SiteKit?.Seasons || [];
      
      // Filter for recent seasons to keep updates efficient (e.g. 2024-25, 2025-26)
      const activeSeasons = seasons.filter(s => {
        const name = s.season_name?.toLowerCase() || "";
        return name.includes("2024-25") || name.includes("2025-26") || name.includes("2026-27");
      });

      console.log(`Identified ${activeSeasons.length} active/recent seasons to synchronize.`);

      for (const season of activeSeasons) {
        if (!season.season_id) continue;
        const seasonId = season.season_id.toString();

        // A. Ingest schedule data
        console.log(`[Schedule Sync] Fetching games for season ${seasonId}...`);
        const scheduleData = await fetchFromApi({ feed: 'modulekit', view: 'schedule', season_id: seasonId });
        const games = scheduleData?.SiteKit?.Schedule || [];

        let count = 0;
        let currentBatch = db.batch();

        for (const game of games) {
          if (!game.game_id) continue;
          const ref = db.collection('pwhl_games').doc(game.game_id.toString());
          currentBatch.set(ref, game, { merge: true });
          count++;

          if (count === 490) {
            await currentBatch.commit();
            currentBatch = db.batch();
            count = 0;
            console.log(`[Schedule Sync] Committed 490-write chunk to Firestore.`);
          }
        }

        if (count > 0) {
          await currentBatch.commit();
          console.log(`[Schedule Sync] Committed final ${count}-write chunk to Firestore.`);
        }

        // B. Ingest player stats data (Top Scorers & Top Goalies)
        console.log(`[Stats Sync] Fetching top scorers for season ${seasonId}...`);
        const statsData = await fetchFromApi({ 
          feed: 'modulekit', 
          view: 'statviewtype', 
          type: 'topscorers', 
          season_id: seasonId, 
          first: 0, 
          limit: 500 
        });
        const skatersStats = statsData?.SiteKit?.Statviewtype || [];

        console.log(`[Stats Sync] Fetching top goalies for season ${seasonId}...`);
        const goaliesData = await fetchFromApi({
          feed: 'modulekit',
          view: 'statviewtype',
          type: 'topgoalies',
          season_id: seasonId,
          first: 0,
          limit: 100
        });
        const goaliesStats = goaliesData?.SiteKit?.Statviewtype || [];

        const allStats = [...skatersStats, ...goaliesStats];

        count = 0;
        currentBatch = db.batch();

        for (const stat of allStats) {
          if (!stat.player_id) continue;
          const ref = db.collection('pwhl_player_stats').doc(`${seasonId}_${stat.player_id}`);
          currentBatch.set(ref, { ...stat, season_id: seasonId }, { merge: true });
          count++;

          if (count === 490) {
            await currentBatch.commit();
            currentBatch = db.batch();
            count = 0;
            console.log(`[Stats Sync] Committed 490-write chunk to Firestore.`);
          }
        }

        if (count > 0) {
          await currentBatch.commit();
          console.log(`[Stats Sync] Committed final ${count}-write chunk to Firestore.`);
        }
      }

      console.log("Daily scheduled ingestion finished successfully!");
      return null;
    } catch (error) {
      console.error("Fatal error during daily Scheduled Ingestion:", error);
      throw error;
    }
  });

/**
 * Helper to fetch the simulated time travel cutoff date
 */
async function getCutoffDate() {
  return new Date(await getSystemDate());
}

/**
 * Cloud Function triggered on game summary/box score changes.
 * Automatically aggregates seasonal statistics, applies custom league scoring settings,
 * and writes player snapshots into the pwhl_season_player_stats collection.
 */
/**
 * Core dynamic player stats and fantasy points aggregation helper.
 */
async function crunchStatsAndFantasyPoints(seasonIdStr, cutoffDate) {
  // 1. Fetch all games for this season to determine which are Final BEFORE cutoff
  const gamesSnap = await db.collection("pwhl_games")
    .where("season_id", "in", [seasonIdStr, Number(seasonIdStr)])
    .get();

  const pastGameIds = new Set();
  gamesSnap.forEach(docSnap => {
    const game = docSnap.data();
    // status '4' = Final in PWHL schedule feed
    const isFinal = game.status === "4" || game.status === "3";
    if (!isFinal) return;

    const gDateStr = game.date_played || game.date;
    if (!gDateStr) return;
    const gameDate = new Date(gDateStr);
    if (gameDate < cutoffDate) {
      pastGameIds.add(game.game_id.toString());
    }
  });

  console.log(`[Aggregator] Found ${pastGameIds.size} completed games prior to cutoff: ${cutoffDate.toISOString()}`);

  const skaters = {};
  const goalies = {};

  const getSkaterObj = (id) => {
    const key = String(id);
    if (!skaters[key]) {
      skaters[key] = {
        gamesPlayed: 0, goals: 0, assists: 0,
        powerPlayGoals: 0, powerPlayAssists: 0, powerPlayPoints: 0,
        shortHandedGoals: 0, shortHandedAssists: 0, shortHandedPoints: 0,
        pim: 0, plusMinus: 0, shotsOnGoal: 0, blockedShots: 0, hits: 0,
        timeOnIce: 0, averageTimeOnIce: 0
      };
    }
    return skaters[key];
  };

  const getGoalieObj = (id) => {
    const key = String(id);
    if (!goalies[key]) {
      goalies[key] = {
        gamesPlayed: 0, wins: 0, losses: 0, overtimeLosses: 0,
        shotsSaved: 0, goalsAgainst: 0, shutouts: 0,
        timeOnIce: 0, averageTimeOnIce: 0
      };
    }
    return goalies[key];
  };

  // If there are completed games, fetch their summaries and aggregate them
  if (pastGameIds.size > 0) {
    const summariesSnap = await db.collection("pwhl_game_summaries")
      .where("season_id", "in", [seasonIdStr, Number(seasonIdStr)])
      .get();

    summariesSnap.forEach(docSnap => {
      if (!pastGameIds.has(docSnap.id)) return;

      const summary = docSnap.data();

      // Aggregate goals, assists, power play / short handed stats from scoring array
      const scoringPlays = Array.isArray(summary.goals) ? summary.goals : [];
      const assistCounts = {};
      const goalCounts = {};

      const getAssistCounter = (id) => {
        if (!assistCounts[id]) assistCounts[id] = { assists: 0, ppAssists: 0, shAssists: 0 };
        return assistCounts[id];
      };
      const getGoalCounter = (id) => {
        if (!goalCounts[id]) goalCounts[id] = { ppGoals: 0, shGoals: 0 };
        return goalCounts[id];
      };

      scoringPlays.forEach(goal => {
        const isPP = goal.power_play === "1" || goal.power_play === 1;
        const isSH = goal.short_handed === "1" || goal.short_handed === 1;

        if (goal.goal_scorer?.player_id) {
          const gObj = getGoalCounter(goal.goal_scorer.player_id);
          if (isPP) gObj.ppGoals++;
          if (isSH) gObj.shGoals++;
        }

        [goal.assist1_player, goal.assist2_player].forEach(a => {
          if (!a?.player_id) return;
          const aObj = getAssistCounter(a.player_id);
          aObj.assists++;
          if (isPP) aObj.ppAssists++;
          if (isSH) aObj.shAssists++;
        });
      });

      // Skaters
      const processSkatersList = (players) => {
        if (!Array.isArray(players)) return;
        players.forEach(player => {
          const id = player.player_id;
          if (!id) return;
          const s = getSkaterObj(id);
          s.gamesPlayed += 1;

          s.goals += parseInt(player.goals || 0);
          s.pim += parseInt(player.pim || 0);
          s.shotsOnGoal += parseInt(player.shots_on || player.shots || 0);
          s.blockedShots += parseInt(player.shots_blocked_by_player || player.shots_blocked || 0);
          s.hits += parseInt(player.hits || 0);

          const pm = player.plusminus;
          if (pm !== undefined && pm !== null && pm !== "") {
            s.plusMinus += parseInt(pm, 10) || 0;
          }

          const assistObj = assistCounts[id];
          if (assistObj) {
            s.assists += assistObj.assists;
            s.powerPlayAssists += assistObj.ppAssists;
            s.shortHandedAssists += assistObj.shAssists;
          }

          const goalObj = goalCounts[id];
          if (goalObj) {
            s.powerPlayGoals += goalObj.ppGoals;
            s.shortHandedGoals += goalObj.shGoals;
          }

          s.powerPlayPoints = s.powerPlayGoals + s.powerPlayAssists;
          s.shortHandedPoints = s.shortHandedGoals + s.shortHandedAssists;
        });
      };

      processSkatersList(summary.home_team_lineup?.players);
      processSkatersList(summary.visitor_team_lineup?.players);

      // Goalies
      const processGoaliesList = (goalieList) => {
        if (!Array.isArray(goalieList)) return;
        
        const goalieMap = {};
        goalieList.forEach(goalie => {
          const id = goalie.player_id;
          if (!id) return;
          const idStr = String(id);
          
          let secs = parseInt(goalie.seconds || goalie.secs || 0);
          if (!secs && goalie.secs_mmss && goalie.secs_mmss.includes(':')) {
            const [m, s] = goalie.secs_mmss.split(':').map(Number);
            secs = m * 60 + s;
          }

          if (!goalieMap[idStr]) {
            goalieMap[idStr] = {
              saves: parseInt(goalie.saves || 0),
              goalsAgainst: parseInt(goalie.goals_against || 0),
              wins: parseInt(goalie.win || 0),
              losses: parseInt(goalie.loss || 0),
              overtimeLosses: parseInt(goalie.ot_loss || 0),
              shutouts: parseInt(goalie.shutout || 0),
              timeOnIce: secs
            };
          } else {
            const existing = goalieMap[idStr];
            existing.saves += parseInt(goalie.saves || 0);
            existing.goalsAgainst += parseInt(goalie.goals_against || 0);
            existing.wins = Math.max(existing.wins, parseInt(goalie.win || 0));
            existing.losses = Math.max(existing.losses, parseInt(goalie.loss || 0));
            existing.overtimeLosses = Math.max(existing.overtimeLosses, parseInt(goalie.ot_loss || 0));
            existing.shutouts = Math.max(existing.shutouts, parseInt(goalie.shutout || 0));
            existing.timeOnIce += secs;
          }
        });

        for (const [id, stats] of Object.entries(goalieMap)) {
          const g = getGoalieObj(id);
          // A goalie is considered to have played in the game if they played at least 1 second or recorded a save/allowed a goal
          if (stats.timeOnIce > 0 || stats.saves > 0 || stats.goalsAgainst > 0) {
            g.gamesPlayed += 1;
            g.shotsSaved += stats.saves;
            g.goalsAgainst += stats.goalsAgainst;
            g.wins += stats.wins;
            g.losses += stats.losses;
            g.overtimeLosses += stats.overtimeLosses;
            g.shutouts += stats.shutouts;
            g.timeOnIce += stats.timeOnIce;
          }
        }
      };

      if (summary.goalies && typeof summary.goalies === "object") {
        processGoaliesList(summary.goalies.home);
        processGoaliesList(summary.goalies.visitor);
      }
    });

    // Compute averages
    Object.values(skaters).forEach(s => {
      s.averageTimeOnIce = s.gamesPlayed > 0 ? Math.round(s.timeOnIce / s.gamesPlayed) : 0;
    });
    Object.values(goalies).forEach(g => {
      g.averageTimeOnIce = g.gamesPlayed > 0 ? Math.round(g.timeOnIce / g.gamesPlayed) : 0;
    });
  }

  // 3. Fetch players reference to map metadata
  const playersSnap = await db.collection("pwhl_players")
    .where("season_id", "in", [seasonIdStr, Number(seasonIdStr)])
    .get();

  const playersMap = {};
  playersSnap.forEach(docSnap => {
    const p = docSnap.data();
    const id = p.player_id || p.id || docSnap.id.split("_")[1];
    if (id) {
      playersMap[id.toString()] = {
        name: `${p.first_name || ""} ${p.last_name || ""}`.trim() || p.name || "Unknown Player",
        position: p.position || "F",
        teamId: p.current_team_id || p.team_id || ""
      };
    }
  });

  // 4. Fetch all active fantasy leagues to compute custom scoring values
  const leaguesSnap = await db.collection("fantasy_leagues").get();

  const defaultScoring = {
    skaters: {
      goals: 2, assists: 1, plusMinus: 0.5, ppp: 0.5, shp: 0.5, sog: 0.1, hits: 0.1, blocks: 0.5, defensePoints: 0.5
    },
    goalies: {
      wins: 4, otl: 1, ga: -2, saves: 0.2, shutouts: 3
    }
  };

  let count = 0;
  let batch = db.batch();

  const scoringContexts = leaguesSnap.docs.map(docSnap => ({
    id: docSnap.id,
    scoring: docSnap.data().scoringSettings || defaultScoring
  }));
  scoringContexts.push({ id: "global", scoring: defaultScoring });

  const timestampValue = Timestamp.fromDate(cutoffDate);

  for (const context of scoringContexts) {
    const leagueId = context.id;
    const rules = context.scoring;

    // A. Skaters
    for (const [playerId, s] of Object.entries(skaters)) {
      const playerRef = playersMap[playerId] || { name: "Unknown Player", position: "F", teamId: "" };
      
      let points = 0;
      const matrix = rules.skaters || defaultScoring.skaters;
      
      points += (s.goals || 0) * (matrix.goals || 0);
      points += (s.assists || 0) * (matrix.assists || 0);
      points += (s.plusMinus || 0) * (matrix.plusMinus || 0);
      points += (s.powerPlayPoints || 0) * (matrix.ppp || 0);
      points += (s.shortHandedPoints || 0) * (matrix.shp || 0);
      points += (s.shotsOnGoal || 0) * (matrix.sog || 0);
      points += (s.hits || 0) * (matrix.hits || 0);
      points += (s.blockedShots || 0) * (matrix.blocks || 0);

      if (playerRef.position === "D" || playerRef.position === "Defense") {
        points += ((s.goals || 0) + (s.assists || 0)) * (matrix.defensePoints || 0);
      }

      const fantasyPoints = Math.round(points * 100) / 100;
      const docId = `${seasonIdStr}_${leagueId}_${playerId}`;
      const docRef = db.collection("pwhl_season_player_stats").doc(docId);

      batch.set(docRef, {
        seasonId: seasonIdStr,
        leagueId: leagueId,
        playerId: playerId,
        playerName: playerRef.name,
        teamId: playerRef.teamId,
        position: playerRef.position,
        stats: s,
        fantasyPoints: fantasyPoints,
        updatedAt: timestampValue
      }, { merge: true });

      count++;
      if (count === 490) {
        await batch.commit();
        batch = db.batch();
        count = 0;
      }
    }

    // B. Goalies
    for (const [playerId, g] of Object.entries(goalies)) {
      const playerRef = playersMap[playerId] || { name: "Unknown Player", position: "G", teamId: "" };

      let points = 0;
      const matrix = rules.goalies || defaultScoring.goalies;

      points += (g.wins || 0) * (matrix.wins || 0);
      points += (g.overtimeLosses || 0) * (matrix.otl || 0);
      points += (g.goalsAgainst || 0) * (matrix.ga || 0);
      points += (g.shotsSaved || 0) * (matrix.saves || 0);
      points += (g.shutouts || 0) * (matrix.shutouts || 0);

      const fantasyPoints = Math.round(points * 100) / 100;
      const docId = `${seasonIdStr}_${leagueId}_${playerId}`;
      const docRef = db.collection("pwhl_season_player_stats").doc(docId);

      batch.set(docRef, {
        seasonId: seasonIdStr,
        leagueId: leagueId,
        playerId: playerId,
        playerName: playerRef.name,
        teamId: playerRef.teamId,
        position: playerRef.position,
        stats: g,
        fantasyPoints: fantasyPoints,
        updatedAt: timestampValue
      }, { merge: true });

      count++;
      if (count === 490) {
        await batch.commit();
        batch = db.batch();
        count = 0;
      }
    }
  }

  if (count > 0) {
    await batch.commit();
  }
}

/**
 * Cloud Function triggered on game summary/box score changes.
 * Automatically aggregates seasonal statistics, applies custom league scoring settings,
 * and writes player snapshots into the pwhl_season_player_stats collection.
 */
exports.onGameSummaryWritten = onDocumentWritten("pwhl_game_summaries/{gameId}", async (event) => {
  const snapshot = event.data;
  if (!snapshot) {
    console.log("No event snapshot data.");
    return null;
  }

  const triggerData = snapshot.after.exists ? snapshot.after.data() : snapshot.before.data();
  if (!triggerData) {
    console.log("No data present in trigger snapshot.");
    return null;
  }

  // Identify season ID
  let seasonId = triggerData.season_id;
  if (!seasonId) {
    // Attempt fallback lookup from pwhl_games
    const gameId = event.params.gameId;
    console.log(`Season ID missing in summary, looking up game ${gameId}...`);
    const gameSnap = await db.collection("pwhl_games").doc(gameId.toString()).get();
    if (gameSnap.exists) {
      seasonId = gameSnap.data().season_id;
    }
  }

  if (!seasonId) {
    console.error(`Could not resolve season ID for game ${event.params.gameId}. Aborting statistics calculation.`);
    return null;
  }

  const seasonIdStr = seasonId.toString();
  console.log(`Processing player stats updates for season: ${seasonIdStr}`);

  // 1. Fetch time travel cutoff date
  const cutoffDate = await getCutoffDate();

  await crunchStatsAndFantasyPoints(seasonIdStr, cutoffDate);
  return null;
});

/**
 * HTTPS Callable Cloud Function to initialize the QA Simulation Sandbox.
 * Automatically provisions a test sandbox consisting of 7 bot users,
 * an active 8-team filled league, 8 team sheets, and a 7-week matchup schedule.
 */
exports.initializeTestEnvironment = functions.https.onCall(async (data, context) => {
  try {
    // 1. Enforce user authentication
    if (!context.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "The function must be called by an authenticated user."
      );
    }

    const adminUid = context.auth.uid;
    const adminEmail = context.auth.token ? context.auth.token.email : null;

    // 2. Enforce admin privilege check
    const userRef = db.collection("users").doc(adminUid);
    const userSnap = await userRef.get();

    const isSuperAdmin = adminEmail === "justinemerick79@gmail.com";
    const isExplicitAdmin = userSnap.exists && userSnap.data().role === "admin";

    if (!isSuperAdmin && !isExplicitAdmin) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "Only authenticated admin accounts can initialize the simulation mode."
      );
    }

    console.log(`[Simulation] Admin ${adminUid} started test environment setup...`);

    // Initialize references
    const leagueRef = db.collection("fantasy_leagues").doc();
    const leagueId = leagueRef.id;

    // Generate 7 Bot UIDs & Refs
    const botUids = [];
    const botRefs = [];
    for (let i = 1; i <= 7; i++) {
      const botRef = db.collection("users").doc();
      botUids.push(botRef.id);
      botRefs.push(botRef);
    }

    // Define defaults
    const defaultRosterSettings = {
      forwards: { starters: 6, max: 10 },
      defense: { starters: 4, max: 8 },
      goalies: { starters: 1, max: 3 },
      bench: 4
    };
    const defaultScoringSettings = {
      skaters: {
        goals: 2, assists: 1, plusMinus: 0.5, ppp: 0.5, shp: 0.5, sog: 0.1, hits: 0.1, blocks: 0.5, defensePoints: 0.5
      },
      goalies: {
        wins: 4, otl: 1, ga: -2, saves: 0.2, shutouts: 3
      }
    };
    const defaultScheduleSettings = {
      matchupDuration: 1,
      playoffTeams: 4,
      playoffDuration: 1
    };

    const batch = db.batch();

    // Auto-elevate the super-admin user document in database if it doesn't have the admin role
    if (isSuperAdmin && (!userSnap.exists || userSnap.data().role !== "admin")) {
      batch.set(userRef, {
        email: adminEmail,
        role: "admin",
        isTestNode: true
      }, { merge: true });
    }

    const systemTimeMs = await getSystemDate();
    const systemTimestamp = Timestamp.fromMillis(systemTimeMs);

    // A. Create 7 Bot Users
    for (let i = 0; i < 7; i++) {
      batch.set(botRefs[i], {
        email: `bot_${i + 1}_${leagueId.slice(0, 4)}@fantasy.com`,
        displayName: `Bot Team ${i + 1}`,
        role: "user",
        isBot: true,
        isTestNode: true,
        createdAt: systemTimestamp
      });
    }

    // B. Create Admin Team document
    const adminTeamRef = leagueRef.collection("teams").doc();
    batch.set(adminTeamRef, {
      ownerId: adminUid,
      teamName: "Admin Vipers",
      avatar: "🏒",
      isTestNode: true,
      joinedAt: systemTimestamp
    });

    // C. Create 7 Bot Team documents
    const botTeamRefs = [];
    for (let i = 0; i < 7; i++) {
      const botTeamRef = leagueRef.collection("teams").doc();
      botTeamRefs.push(botTeamRef);
      batch.set(botTeamRef, {
        ownerId: botUids[i],
        teamName: `Bot Team ${i + 1}`,
        avatar: "🤖",
        isTestNode: true,
        joinedAt: systemTimestamp
      });
    }

    // D. Read active season ID and its weeks array
    let activeSeasonId = "5";
    try {
      const activeSeasonSnap = await db.collection("app_settings").doc("active_season").get();
      if (activeSeasonSnap.exists && activeSeasonSnap.data().active_season_id) {
        activeSeasonId = String(activeSeasonSnap.data().active_season_id);
      }
    } catch (err) {
      console.error("Error reading active season setting:", err);
    }

    let weeks = [];
    try {
      const seasonSnap = await db.collection("pwhl_seasons").doc(activeSeasonId).get();
      if (seasonSnap.exists && seasonSnap.data().weeks) {
        weeks = seasonSnap.data().weeks;
      }
    } catch (err) {
      console.error("Error reading season weeks:", err);
    }

    const activeWeeks = weeks.filter(w => !w.isOffWeek);
    const getActiveWeekNum = (roundIndex) => {
      if (activeWeeks.length === 0) return roundIndex + 1;
      const idx = roundIndex % activeWeeks.length;
      return activeWeeks[idx].week;
    };

    // E. Create filled League document (active_full)
    const allMembers = [adminUid, ...botUids];
    batch.set(leagueRef, {
      name: "Simulation Test League",
      ownerId: adminUid,
      commissionerId: adminUid,
      maxTeams: 8,
      inviteCode: "SIMTEST",
      members: allMembers,
      userIds: allMembers,
      status: "active_full",
      isTestNode: true,
      season_id: activeSeasonId,
      createdAt: systemTimestamp,
      rosterSettings: defaultRosterSettings,
      scoringSettings: defaultScoringSettings,
      scheduleSettings: defaultScheduleSettings,
      waiverOrder: [adminTeamRef.id, ...botTeamRefs.map(r => r.id)]
    });

    // F. Generate mathematically perfect Weekly H2H Matchups (Circle Rotation, Double Round-Robin for 14 weeks)
    const numTeams = 8;
    const teamIds = [adminTeamRef.id, ...botTeamRefs.map(r => r.id)];
    
    const teamNamesMap = {
      [adminTeamRef.id]: "Admin Vipers"
    };
    for (let i = 0; i < 7; i++) {
      teamNamesMap[botTeamRefs[i].id] = `Bot Team ${i + 1}`;
    }

    const list = [...teamIds];

    for (let round = 0; round < 7; round++) {
      const weekNum1 = getActiveWeekNum(round);
      const weekNum2 = getActiveWeekNum(round + 7);
      for (let i = 0; i < numTeams / 2; i++) {
        const home = list[i];
        const away = list[numTeams - 1 - i];
        
        // First round-robin (Weeks 1-7)
        const matchupRef1 = leagueRef.collection("matchups").doc(`week_${weekNum1}_matchup_${i + 1}`);
        batch.set(matchupRef1, {
          week: weekNum1,
          homeTeamId: home,
          awayTeamId: away,
          homeTeamName: teamNamesMap[home],
          awayTeamName: teamNamesMap[away],
          homeScore: 0,
          awayScore: 0,
          status: "pending",
          isTestNode: true,
          createdAt: systemTimestamp
        });

        // Second round-robin (Weeks 8-14, home and away swapped)
        const matchupRef2 = leagueRef.collection("matchups").doc(`week_${weekNum2}_matchup_${i + 1}`);
        batch.set(matchupRef2, {
          week: weekNum2,
          homeTeamId: away,
          awayTeamId: home,
          homeTeamName: teamNamesMap[away],
          awayTeamName: teamNamesMap[home],
          homeScore: 0,
          awayScore: 0,
          status: "pending",
          isTestNode: true,
          createdAt: systemTimestamp
        });
      }
      
      // Circle method rotation (keeping list[0] fixed)
      const last = list[numTeams - 1];
      for (let j = numTeams - 1; j > 1; j--) {
        list[j] = list[j - 1];
      }
      list[1] = last;
    }

    // F. Create Global simulation state
    const simStateRef = db.collection("admin_settings").doc("simulation_state");
    batch.set(simStateRef, {
      testModeActive: true,
      current_simulated_date: null,
      active_test_league_id: leagueId,
      isTestNode: true
    });

    // Execute batch transactions
    await batch.commit();

    console.log(`[Simulation] Test environment initialized. League: ${leagueId}`);

    return {
      success: true,
      active_test_league_id: leagueId,
      leagueName: "Simulation Test League"
    };
  } catch (error) {
    console.error("CRITICAL ERROR IN initializeTestEnvironment:", error);
    if (error instanceof functions.https.HttpsError) {
      throw error;
    }
    let msg = error.message || error.toString();
    if (msg.includes("UNAVAILABLE") || msg.includes("No connection established") || msg.includes("connection")) {
      msg = `Firestore Emulator connection failed. Please ensure the Firestore emulator is running on port 8080 (requires Java JRE). Original error: ${msg}`;
    }
    throw new functions.https.HttpsError(
      "unknown",
      msg,
      error.stack
    );
  }
});

/**
 * HTTPS Callable Cloud Function to deactivate QA Simulation Sandbox.
 * Automatically cleans up the simulation sandbox by deleting all bot users,
 * the simulation league, all teams, matchups, waivers, claims, and trades under it,
 * and resets simulation state and time travel settings.
 */
exports.deactivateSimulation = functions.https.onCall(async (data, context) => {
  try {
    // 1. Enforce user authentication
    if (!context.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "The function must be called by an authenticated user."
      );
    }

    const adminUid = context.auth.uid;
    const adminEmail = context.auth.token ? context.auth.token.email : null;

    // 2. Enforce admin privilege check
    const userRef = db.collection("users").doc(adminUid);
    const userSnap = await userRef.get();

    const isSuperAdmin = adminEmail === "justinemerick79@gmail.com";
    const isExplicitAdmin = userSnap.exists && userSnap.data().role === "admin";

    if (!isSuperAdmin && !isExplicitAdmin) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "Only authenticated admin accounts can deactivate the simulation mode."
      );
    }

    console.log(`[Simulation] Admin ${adminUid} started deactivating simulation...`);

    // 3. Get the active test league ID from simulation state
    const simStateRef = db.collection("admin_settings").doc("simulation_state");
    const simStateSnap = await simStateRef.get();
    let testLeagueId = "";
    if (simStateSnap.exists) {
      testLeagueId = simStateSnap.data().active_test_league_id || "";
    }

    const batch = db.batch();

    // 4. Delete the test league and all its subcollections
    if (testLeagueId) {
      console.log(`[Simulation] Cleaning up test league: ${testLeagueId}`);
      const leagueRef = db.collection("fantasy_leagues").doc(testLeagueId);

      // Fetch and delete teams subcollection
      const teamsSnap = await leagueRef.collection("teams").get();
      teamsSnap.forEach((doc) => {
        batch.delete(doc.ref);
      });

      // Fetch and delete matchups subcollection
      const matchupsSnap = await leagueRef.collection("matchups").get();
      matchupsSnap.forEach((doc) => {
        batch.delete(doc.ref);
      });

      // Fetch and delete waivers subcollection if any
      const waiversSnap = await leagueRef.collection("waivers").get();
      waiversSnap.forEach((doc) => {
        batch.delete(doc.ref);
      });

      // Fetch and delete waiver_claims subcollection if any
      const claimsSnap = await leagueRef.collection("waiver_claims").get();
      claimsSnap.forEach((doc) => {
        batch.delete(doc.ref);
      });

      // Fetch and delete trades subcollection if any
      const tradesSnap = await leagueRef.collection("trades").get();
      tradesSnap.forEach((doc) => {
        batch.delete(doc.ref);
      });

      // Delete the main league document
      batch.delete(leagueRef);
    }

    // 5. Delete all bot users (isBot == true)
    const botsSnap = await db.collection("users").where("isBot", "==", true).get();
    console.log(`[Simulation] Found ${botsSnap.size} bot users to delete`);
    botsSnap.forEach((doc) => {
      batch.delete(doc.ref);
    });

    // 6. Reset simulation state
    batch.set(simStateRef, {
      testModeActive: false,
      current_simulated_date: null,
      active_test_league_id: "",
      isTestNode: false
    });

    // 7. Delete app_settings/time_travel
    const timeTravelRef = db.collection("app_settings").doc("time_travel");
    batch.delete(timeTravelRef);

    // Commit all deletions
    await batch.commit();

    console.log("[Simulation] Simulation sandbox deactivated successfully.");

    return {
      success: true
    };
  } catch (error) {
    console.error("CRITICAL ERROR IN deactivateSimulation:", error);
    if (error instanceof functions.https.HttpsError) {
      throw error;
    }
    throw new functions.https.HttpsError("unknown", error.message || error.toString());
  }
});

/**
 * HTTPS Callable function to retrieve the current simulated system clock time.
 * Used for testing and verification of the central clock.
 */
exports.getSimulatedTime = functions.https.onCall(async (data, context) => {
  const timeMs = await getSystemDate();
  return { timeMs };
});

/**
 * Background Auto-Draft Simulator.
 * Listens to active snake drafts in the local environment.
 * If the current pick belongs to a bot (isBot: true), it waits 3 seconds,
 * selects the highest-ranked available player, and executes a transaction to
 * draft that player and advance the clock/pick turn.
 */
const processingDrafts = new Set();

async function handleDraftStateChange(docSnap) {
  const docRef = docSnap.ref;
  const draftPath = docRef.path;
  const draftData = docSnap.data();

  // 1. Only process active drafts
  if (!draftData || draftData.status !== "active") return;

  const currentPickerId = draftData.current_pick_owner_id || draftData.currentTeamOnClock;
  if (!currentPickerId) return;

  // Avoid processing the same pick multiple times concurrently
  const currentPickIndex = draftData.currentPickIndex !== undefined ? draftData.currentPickIndex : (draftData.current_pick_index || 0);
  const processKey = `${draftPath}_${currentPickIndex}`;
  if (processingDrafts.has(processKey)) return;
  processingDrafts.add(processKey);

  try {
    // 2. Fetch user profile to check if they are a bot
    const userRef = db.collection("users").doc(currentPickerId);
    const userSnap = await userRef.get();
    if (!userSnap.exists || !userSnap.data().isBot) {
      // It's a human user - pause the draft and wait for manual UI input
      processingDrafts.delete(processKey);
      return;
    }

    console.log(`[Draft Engine] Bot turn detected for bot user: ${currentPickerId} at path: ${draftPath} (Pick index: ${currentPickIndex})`);

    // 3. Wait 3 seconds to simulate thinking
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Get the latest draft state doc to ensure we have fresh data before committing to pick
    const freshDraftSnap = await docRef.get();
    const freshDraftData = freshDraftSnap.data();
    if (!freshDraftData || freshDraftData.status !== "active") {
      processingDrafts.delete(processKey);
      return;
    }
    const freshPickerId = freshDraftData.current_pick_owner_id || freshDraftData.currentTeamOnClock;
    if (freshPickerId !== currentPickerId) {
      processingDrafts.delete(processKey);
      return;
    }

    // 4. Resolve parent collection and league ID
    const pathSegments = draftPath.split("/");
    const parentCollection = pathSegments[0]; // e.g. "fantasy_leagues" or "leagues"
    const leagueId = pathSegments[1];

    // 5. Fetch all players and teams outside the transaction (disallowed inside transaction)
    const playersSnap = await db.collection("pwhl_players").get();
    let allPlayers = playersSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Fallback scouting pool if collection is empty
    if (allPlayers.length === 0) {
      allPlayers = [
        { id: "pwhl_1", name: "Marie-Philip Poulin", pos: "F", team: "MTL", rating: 94, stats: "2G, 1A, +3", points: 28.5 },
        { id: "pwhl_2", name: "Natalie Spooner", pos: "F", team: "TOR", rating: 92, stats: "3G, 1A, +2", points: 34.0 },
        { id: "pwhl_3", name: "Sarah Nurse", pos: "F", team: "TOR", rating: 89, stats: "1G, 1A, +1", points: 19.0 },
        { id: "pwhl_4", name: "Hilary Knight", pos: "F", team: "BOS", rating: 90, stats: "1G, 0A, -1", points: 14.5 },
        { id: "pwhl_5", name: "Alex Carpenter", pos: "F", team: "NY", rating: 88, stats: "1G, 2A, +1", points: 21.0 },
        { id: "pwhl_6", name: "Brianne Jenner", pos: "F", team: "OTT", rating: 87, stats: "0G, 2A, 0", points: 12.0 },
        { id: "pwhl_7", name: "Kendall Coyne Schofield", pos: "F", team: "MIN", rating: 89, stats: "1G, 1A, 0", points: 15.5 },
        { id: "pwhl_8", name: "Erin Ambrose", pos: "D", team: "MTL", rating: 91, stats: "0G, 3A, +2", points: 22.0 },
        { id: "pwhl_9", name: "Renata Fast", pos: "D", team: "TOR", rating: 90, stats: "1G, 0A, +1", points: 18.5 },
        { id: "pwhl_10", name: "Megan Keller", pos: "D", team: "BOS", rating: 89, stats: "0G, 2A, -1", points: 15.0 },
        { id: "pwhl_11", name: "Jocelyne Larocque", pos: "D", team: "TOR", rating: 86, stats: "0G, 1A, 0", points: 11.5 },
        { id: "pwhl_12", name: "Aerin Frankel", pos: "G", team: "BOS", rating: 93, stats: "2W, 58SV, 1.95GAA", points: 42.0 },
        { id: "pwhl_13", name: "Ann-Renée Desbiens", pos: "G", team: "MTL", rating: 91, stats: "1W, 54SV, 2.45GAA", points: 32.0 },
        { id: "pwhl_14", name: "Nicole Hensley", pos: "G", team: "MIN", rating: 88, stats: "1W, 52SV, 2.80GAA", points: 27.5 }
      ];
    }

    const teamsSnap = await db.collection(parentCollection).doc(leagueId).collection("teams").get();
    const teams = teamsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const botTeam = teams.find(t => t.ownerId === currentPickerId);

    // 6. Run Firestore transaction to execute the pick
    await db.runTransaction(async (transaction) => {
      // Re-read draft state and league within transaction
      const txDraftSnap = await transaction.get(docRef);
      if (!txDraftSnap.exists) return;
      const txDraftData = txDraftSnap.data();

      if (txDraftData.status !== "active") return;
      const txPickerId = txDraftData.current_pick_owner_id || txDraftData.currentTeamOnClock;
      if (txPickerId !== currentPickerId) return;

      const txLeagueRef = db.collection(parentCollection).doc(leagueId);
      const txLeagueSnap = await transaction.get(txLeagueRef);
      if (!txLeagueSnap.exists) return;
      const leagueData = txLeagueSnap.data();

      // Find already drafted player IDs from picks and active rosters
      const draftedIds = new Set();
      const picks = txDraftData.picks || [];
      picks.forEach(p => {
        if (p.playerId) draftedIds.add(p.playerId);
        if (p.player_id) draftedIds.add(p.player_id);
      });
      const activeRosters = txDraftData.activeRosters || txDraftData.active_rosters || {};
      Object.values(activeRosters).forEach(roster => {
        if (Array.isArray(roster)) {
          roster.forEach(id => draftedIds.add(id));
        }
      });

      // Filter available players respecting roster position limits
      const botRosterIds = activeRosters[currentPickerId] || [];
      let fCount = 0;
      let dCount = 0;
      let gCount = 0;

      botRosterIds.forEach(pId => {
        const pInfo = allPlayers.find(p => String(p.id) === String(pId) || String(p.player_id) === String(pId));
        const pos = pInfo?.position || pInfo?.pos || 'F';
        if (pos === 'F' || pos === 'Forward') fCount++;
        else if (pos === 'D' || pos === 'Defense' || pos === 'Defenseman') dCount++;
        else if (pos === 'G' || pos === 'Goalie') gCount++;
      });

      const rosterSettings = leagueData.rosterSettings || { bench: 4, forwards: { starters: 6, max: 10 }, defense: { starters: 4, max: 8 }, goalies: { starters: 1, max: 3 } };
      const forwardsLimit = rosterSettings.forwards?.max ?? 10;
      const defenseLimit = rosterSettings.defense?.max ?? 8;
      const goaliesLimit = rosterSettings.goalies?.max ?? 3;

      const availablePlayers = allPlayers.filter(p => {
        if (draftedIds.has(p.id) || draftedIds.has(p.player_id || p.id)) return false;

        const pos = p.position || p.pos || 'F';
        if ((pos === 'F' || pos === 'Forward') && fCount >= forwardsLimit) return false;
        if ((pos === 'D' || pos === 'Defense' || pos === 'Defenseman') && dCount >= defenseLimit) return false;
        if ((pos === 'G' || pos === 'Goalie') && gCount >= goaliesLimit) return false;

        return true;
      });

      if (availablePlayers.length === 0) {
        console.warn(`[Draft Engine] No players available matching roster limits for draft in league ${leagueId}`);
        return;
      }

      // Sort by rating (desc), points (desc), and fallback id (asc)
      availablePlayers.sort((a, b) => {
        const ratingA = a.rating !== undefined ? Number(a.rating) : 0;
        const ratingB = b.rating !== undefined ? Number(b.rating) : 0;
        if (ratingB !== ratingA) return ratingB - ratingA;

        const pointsA = a.points !== undefined ? Number(a.points) : 0;
        const pointsB = b.points !== undefined ? Number(b.points) : 0;
        if (pointsB !== pointsA) return pointsB - pointsA;

        return String(a.id).localeCompare(String(b.id));
      });

      const chosenPlayer = availablePlayers[0];
      const chosenPlayerId = chosenPlayer.id || chosenPlayer.player_id;
      const chosenPlayerName = chosenPlayer.name || `${chosenPlayer.first_name || ""} ${chosenPlayer.last_name || ""}`.trim() || chosenPlayerId;

      console.log(`[Draft Engine] Bot ${currentPickerId} picks player: ${chosenPlayerName} (${chosenPlayerId})`);

      // Calculate next pick sequencing details
      const N = txDraftData.draftOrder ? txDraftData.draftOrder.length : (txDraftData.draft_order ? txDraftData.draft_order.length : 8);
      const draftOrder = txDraftData.draftOrder || txDraftData.draft_order || [];
      const txPickIndex = txDraftData.currentPickIndex !== undefined ? txDraftData.currentPickIndex : (txDraftData.current_pick_index || 0);
      const txRound = txDraftData.currentRound !== undefined ? txDraftData.currentRound : (txDraftData.current_round || 1);

      const nextPickIndex = txPickIndex + 1;
      
      const maxRounds = (rosterSettings.bench ?? 4) + 
                        (rosterSettings.forwards?.starters ?? 6) + 
                        (rosterSettings.defense?.starters ?? 4) + 
                        (rosterSettings.goalies?.starters ?? 1);
      const totalPicks = maxRounds * N;

      const systemTimeMs = await getSystemDate();
      const systemTimestamp = Timestamp.fromMillis(systemTimeMs);

      // Create new pick entry
      const newPickEntry = {
        round: txRound,
        pickNumber: nextPickIndex,
        userId: currentPickerId,
        playerId: chosenPlayerId,
        player_id: chosenPlayerId,
        timestamp: systemTimestamp
      };

      const updatedPicks = [...picks, newPickEntry];

      // Update active rosters
      const txActiveRosters = { ...activeRosters };
      txActiveRosters[currentPickerId] = [...(txActiveRosters[currentPickerId] || []), chosenPlayerId];

      // Next picker in snake sequencing
      let nextRound = txRound;
      let nextTeamOnClock = null;
      let nextStatus = 'active';

      if (nextPickIndex >= totalPicks) {
        nextStatus = 'completed';
      } else {
        nextRound = Math.floor(nextPickIndex / N) + 1;
        const pos = nextPickIndex % N;
        if (nextRound % 2 !== 0) {
          nextTeamOnClock = draftOrder[pos];
        } else {
          nextTeamOnClock = draftOrder[(N - 1) - pos];
        }
      }

      const nextDeadline = Timestamp.fromMillis(systemTimeMs + 60000);

      // Prepare schema updates (supports both camelCase and snake_case schemas)
      const draftUpdates = {
        picks: updatedPicks,
        status: nextStatus
      };

      if (txDraftData.currentTeamOnClock !== undefined) {
        draftUpdates.currentTeamOnClock = nextTeamOnClock || currentPickerId;
        draftUpdates.currentPickIndex = nextPickIndex;
        draftUpdates.currentRound = nextRound;
        draftUpdates.pickDeadline = nextDeadline;
        draftUpdates.activeRosters = txActiveRosters;
      }
      if (txDraftData.current_pick_owner_id !== undefined) {
        draftUpdates.current_pick_owner_id = nextTeamOnClock || currentPickerId;
        draftUpdates.current_pick_index = nextPickIndex;
        draftUpdates.current_round = nextRound;
        draftUpdates.pick_deadline = nextDeadline;
        draftUpdates.active_rosters = txActiveRosters;
      }

      transaction.update(docRef, draftUpdates);

      // Assign the player to the team's roster under the subcollection
      if (botTeam) {
        const teamDocRef = db.collection(parentCollection).doc(leagueId).collection("teams").doc(botTeam.id);
        const currentRoster = botTeam.players || [];
        transaction.update(teamDocRef, {
          players: [...currentRoster, chosenPlayerId]
        });
      }

      // If draft is completed, activate league
      if (nextStatus === 'completed') {
        transaction.update(txLeagueRef, { status: 'active' });
      }
    });

  } catch (error) {
    console.error(`[Draft Engine] Error running auto-draft transaction:`, error);
  } finally {
    processingDrafts.delete(processKey);
  }
}

// 7. Subscribe to collection groups in real-time
db.collectionGroup("draft").onSnapshot((snapshot) => {
  snapshot.docChanges().forEach((change) => {
    if (change.type === "added" || change.type === "modified") {
      handleDraftStateChange(change.doc).catch(err => {
        console.error("[Draft Listener Error] draft collection change failed:", err);
      });
    }
  });
}, (err) => {
  console.error("[Draft Listener Error] draft collection group subscription failed:", err);
});

db.collectionGroup("draft_state").onSnapshot((snapshot) => {
  snapshot.docChanges().forEach((change) => {
    if (change.type === "added" || change.type === "modified") {
      handleDraftStateChange(change.doc).catch(err => {
        console.error("[Draft Listener Error] draft_state collection change failed:", err);
      });
    }
  });
}, (err) => {
  console.error("[Draft Listener Error] draft_state collection group subscription failed:", err);
});

/**
 * Cloud Function triggered when the central Time Travel clock updates.
 * Recalculates player statistics up to the new warp date, culls weekly game stats,
 * and handles weekly H2H matchup finalization and standing records.
 */
exports.onSimulationStateWritten = onDocumentWritten("admin_settings/simulation_state", async (event) => {
  const snapshot = event.data;
  if (!snapshot) return null;

  const beforeData = snapshot.before.exists ? snapshot.before.data() : null;
  const afterData = snapshot.after.exists ? snapshot.after.data() : null;
  if (!afterData) return null;

  const oldDateStr = beforeData ? beforeData.current_simulated_date : null;
  const newDateStr = afterData.current_simulated_date;

  // Exit early if simulated date hasn't changed
  if (oldDateStr === newDateStr) return null;
  
  const newDate = newDateStr ? new Date(newDateStr) : new Date();
  const oldDate = oldDateStr ? new Date(oldDateStr) : new Date("2024-09-01T08:00:00-08:00");

  console.log(`[Game Loop] Time warp detected: ${oldDate.toISOString()} ➜ ${newDate.toISOString()}`);

  // 1. Fetch seasons and execute crunchStatsAndFantasyPoints for the warp cutoff
  const seasonsSnap = await db.collection("pwhl_seasons").get();
  const seasonIds = seasonsSnap.docs.map(d => d.id);
  if (seasonIds.length === 0) {
    seasonIds.push("1");
  }

  for (const sId of seasonIds) {
    await crunchStatsAndFantasyPoints(sId, newDate);
  }

  // 2. Fetch all active fantasy leagues
  const leaguesSnap = await db.collection("fantasy_leagues").where("status", "==", "active").get();
  if (leaguesSnap.empty) {
    console.log("[Game Loop] No active leagues found to process.");
    return null;
  }

  const baseTime = new Date("2024-01-01T03:00:00-08:00").getTime();
  const weekMs = 7 * 24 * 60 * 60 * 1000;

  const defaultScoring = {
    skaters: {
      goals: 2, assists: 1, plusMinus: 0.5, ppp: 0.5, shp: 0.5, sog: 0.1, hits: 0.1, blocks: 0.5, defensePoints: 0.5
    },
    goalies: {
      wins: 4, otl: 1, ga: -2, saves: 0.2, shutouts: 3
    }
  };

  // Fetch all players for position info
  const playersSnap = await db.collection("pwhl_players").get();
  const playersPosMap = {};
  playersSnap.forEach(pDoc => {
    const p = pDoc.data();
    const id = p.player_id || p.id || pDoc.id.split("_")[1];
    if (id) {
      playersPosMap[id.toString()] = p.position || "F";
    }
  });

  for (const leagueDoc of leaguesSnap.docs) {
    const leagueId = leagueDoc.id;
    const leagueData = leagueDoc.data();
    const scoringRules = leagueData.scoringSettings || defaultScoring;

    let currentWeek = leagueData.currentWeek || 1;

    const seasonId = leagueData.season_id ? String(leagueData.season_id) : '5';
    let weeks = [];
    try {
      const seasonSnap = await db.collection("pwhl_seasons").doc(seasonId).get();
      if (seasonSnap.exists && seasonSnap.data().weeks) {
        weeks = seasonSnap.data().weeks;
      }
    } catch (err) {
      console.error(`Error loading weeks for season ${seasonId}:`, err);
    }

    const getWeekBounds = (weekNum) => {
      const wk = weeks.find(w => w.week === weekNum);
      if (wk) {
        return {
          start: new Date(wk.start),
          end: new Date(wk.end),
          isOffWeek: !!wk.isOffWeek
        };
      }
      const ws = baseTime + (weekNum - 1) * weekMs;
      const we = baseTime + weekNum * weekMs;
      return {
        start: new Date(ws),
        end: new Date(we),
        isOffWeek: false
      };
    };

    let bounds = getWeekBounds(currentWeek);

    // A. Finalize past weeks sequentially
    while (newDate.getTime() >= bounds.end.getTime()) {
      const w = currentWeek;

      if (bounds.isOffWeek) {
        console.log(`[Game Loop] Week ${w} is an Off Week for league ${leagueId}. Skipping H2H finalization.`);
      } else {
        console.log(`[Game Loop] Finalizing Week ${w} (from ${bounds.start.toISOString()} to ${bounds.end.toISOString()}) for league ${leagueId}`);

        // Query game ids played in week w
        const weeklyGamesSnap = await db.collection("pwhl_games").get();
        const weeklyGameIds = [];
        weeklyGamesSnap.forEach(gDoc => {
          const game = gDoc.data();
          const gDateStr = game.date_played || game.date;
          if (!gDateStr) return;
          const gDate = new Date(gDateStr);
          if (gDate >= bounds.start && gDate < bounds.end && (game.status === "4" || game.status === "3")) {
            weeklyGameIds.push(gDoc.id.toString());
          }
        });

        const weeklySkaters = {};
        const weeklyGoalies = {};
        const getWskater = (id) => {
          if (!weeklySkaters[id]) weeklySkaters[id] = { goals: 0, assists: 0, plusMinus: 0, powerPlayPoints: 0, shortHandedPoints: 0, shotsOnGoal: 0, hits: 0, blockedShots: 0 };
          return weeklySkaters[id];
        };
        const getWgoalie = (id) => {
          if (!weeklyGoalies[id]) weeklyGoalies[id] = { wins: 0, overtimeLosses: 0, goalsAgainst: 0, shotsSaved: 0, shutouts: 0 };
          return weeklyGoalies[id];
        };

        if (weeklyGameIds.length > 0) {
          const summariesSnap = await db.collection("pwhl_game_summaries").get();
          summariesSnap.forEach(sDoc => {
            if (!weeklyGameIds.includes(sDoc.id)) return;
            const summary = sDoc.data();
            const scoringPlays = Array.isArray(summary.goals) ? summary.goals : [];
            const assistCounts = {};
            const goalCounts = {};

            scoringPlays.forEach(goal => {
              const isPP = goal.power_play === "1" || goal.power_play === 1;
              const isSH = goal.short_handed === "1" || goal.short_handed === 1;
              if (goal.goal_scorer?.player_id) {
                if (!goalCounts[goal.goal_scorer.player_id]) goalCounts[goal.goal_scorer.player_id] = { ppGoals: 0, shGoals: 0 };
                const g = goalCounts[goal.goal_scorer.player_id];
                if (isPP) g.ppGoals++;
                if (isSH) g.shGoals++;
              }
              [goal.assist1_player, goal.assist2_player].forEach(a => {
                if (!a?.player_id) return;
                if (!assistCounts[a.player_id]) assistCounts[a.player_id] = { assists: 0, ppAssists: 0, shAssists: 0 };
                const obj = assistCounts[a.player_id];
                obj.assists++;
                if (isPP) obj.ppAssists++;
                if (isSH) obj.shAssists++;
              });
            });

            // Skaters
            const homeSkaters = summary.home_team_lineup?.players || [];
            const visitorSkaters = summary.visitor_team_lineup?.players || [];
            [...homeSkaters, ...visitorSkaters].forEach(player => {
              const id = player.player_id;
              if (!id) return;
              const s = getWskater(id);
              s.goals += parseInt(player.goals || 0);
              s.pim += parseInt(player.pim || 0);
              s.shotsOnGoal += parseInt(player.shots_on || player.shots || 0);
              s.blockedShots += parseInt(player.shots_blocked_by_player || player.shots_blocked || 0);
              s.hits += parseInt(player.hits || 0);
              const pm = player.plusminus;
              if (pm !== undefined && pm !== null && pm !== "") {
                s.plusMinus += parseInt(pm, 10) || 0;
              }
              const assistObj = assistCounts[id];
              if (assistObj) {
                s.assists += assistObj.assists;
                s.powerPlayPoints += (assistObj.ppAssists || 0);
                s.shortHandedPoints += (assistObj.shAssists || 0);
              }
              const goalObj = goalCounts[id];
              if (goalObj) {
                s.powerPlayPoints += (goalObj.ppGoals || 0);
                s.shortHandedPoints += (goalObj.shGoals || 0);
              }
            });

            // Goalies
            const homeGoalies = summary.goalies?.home || [];
            const visitorGoalies = summary.goalies?.visitor || [];
            
            const gameGoaliesMap = {};
            [...homeGoalies, ...visitorGoalies].forEach(goalie => {
              const id = goalie.player_id;
              if (!id) return;
              const idStr = String(id);
              if (!gameGoaliesMap[idStr]) {
                gameGoaliesMap[idStr] = {
                  saves: parseInt(goalie.saves || 0),
                  goalsAgainst: parseInt(goalie.goals_against || 0),
                  wins: parseInt(goalie.win || 0),
                  overtimeLosses: parseInt(goalie.ot_loss || 0),
                  shutouts: parseInt(goalie.shutout || 0)
                };
              } else {
                const existing = gameGoaliesMap[idStr];
                existing.saves += parseInt(goalie.saves || 0);
                existing.goalsAgainst += parseInt(goalie.goals_against || 0);
                existing.wins = Math.max(existing.wins, parseInt(goalie.win || 0));
                existing.overtimeLosses = Math.max(existing.overtimeLosses, parseInt(goalie.ot_loss || 0));
                existing.shutouts = Math.max(existing.shutouts, parseInt(goalie.shutout || 0));
              }
            });

            for (const [id, stats] of Object.entries(gameGoaliesMap)) {
              const g = getWgoalie(id);
              g.shotsSaved += stats.saves;
              g.goalsAgainst += stats.goalsAgainst;
              g.wins += stats.wins;
              g.overtimeLosses += stats.overtimeLosses;
              g.shutouts += stats.shutouts;
            }
          });
        }

        // Fetch all teams for this league
        const teamsSnap = await db.collection("fantasy_leagues").doc(leagueId).collection("teams").get();
        const teams = teamsSnap.docs.map(tDoc => ({ id: tDoc.id, ...tDoc.data() }));

        const calculateStartingRosterWeekScore = (teamPlayers) => {
          const unusedIds = [...teamPlayers];
          const layoutSlots = [
            { pos: "F" }, { pos: "F" }, { pos: "F" }, { pos: "F" }, { pos: "F" }, { pos: "F" },
            { pos: "D" }, { pos: "D" }, { pos: "D" }, { pos: "D" },
            { pos: "G" }
          ];
          const starters = [];
          layoutSlots.forEach(slot => {
            const matchIdx = unusedIds.findIndex(id => {
              const mockPos = id.startsWith("pwhl_") ? (id.startsWith("pwhl_12") || id.startsWith("pwhl_13") || id.startsWith("pwhl_14") ? "G" : (id.startsWith("pwhl_8") || id.startsWith("pwhl_9") || id.startsWith("pwhl_10") || id.startsWith("pwhl_11") ? "D" : "F")) : null;
              const pos = playersPosMap[id] || mockPos || "F";
              return pos === slot.pos;
            });
            if (matchIdx !== -1) {
              starters.push(unusedIds[matchIdx]);
              unusedIds.splice(matchIdx, 1);
            }
          });

          let totalPoints = 0;
          starters.forEach(pId => {
            const skaterStats = weeklySkaters[pId];
            const goalieStats = weeklyGoalies[pId];
            const mockPos = pId.startsWith("pwhl_") ? (pId.startsWith("pwhl_12") || pId.startsWith("pwhl_13") || pId.startsWith("pwhl_14") ? "G" : (pId.startsWith("pwhl_8") || pId.startsWith("pwhl_9") || pId.startsWith("pwhl_10") || pId.startsWith("pwhl_11") ? "D" : "F")) : null;
            const pos = playersPosMap[pId] || mockPos || "F";

            let points = 0;
            if (pos === "G" && goalieStats) {
              const matrix = scoringRules.goalies || defaultScoring.goalies;
              points += (goalieStats.wins || 0) * (matrix.wins || 0);
              points += (goalieStats.overtimeLosses || 0) * (matrix.otl || 0);
              points += (goalieStats.goalsAgainst || 0) * (matrix.ga || 0);
              points += (goalieStats.shotsSaved || 0) * (matrix.saves || 0);
              points += (goalieStats.shutouts || 0) * (matrix.shutouts || 0);
            } else if (skaterStats) {
              const matrix = scoringRules.skaters || defaultScoring.skaters;
              points += (skaterStats.goals || 0) * (matrix.goals || 0);
              points += (skaterStats.assists || 0) * (matrix.assists || 0);
              points += (skaterStats.plusMinus || 0) * (matrix.plusMinus || 0);
              points += (skaterStats.powerPlayPoints || 0) * (matrix.ppp || 0);
              points += (skaterStats.shortHandedPoints || 0) * (matrix.shp || 0);
              points += (skaterStats.shotsOnGoal || 0) * (matrix.sog || 0);
              points += (skaterStats.hits || 0) * (matrix.hits || 0);
              points += (skaterStats.blockedShots || 0) * (matrix.blocks || 0);
              if (pos === "D" || pos === "Defense") {
                points += ((skaterStats.goals || 0) + (skaterStats.assists || 0)) * (matrix.defensePoints || 0);
              }
            }
            totalPoints += points;
          });

          return Math.round(totalPoints * 100) / 100;
        };

        const matchupsSnap = await db.collection("fantasy_leagues").doc(leagueId).collection("matchups").where("week", "==", w).get();
        const teamRecordsUpdates = {};

        const getRecordObj = (id) => {
          if (!teamRecordsUpdates[id]) {
            const t = teams.find(team => team.id === id) || {};
            teamRecordsUpdates[id] = {
              wins: t.wins || 0,
              losses: t.losses || 0,
              ties: t.ties || 0,
              points: t.points || 0
            };
          }
          return teamRecordsUpdates[id];
        };

        const txBatch = db.batch();

        for (const mDoc of matchupsSnap.docs) {
          const matchup = mDoc.data();
          const homeTeam = teams.find(t => t.id === matchup.homeTeamId) || { players: [] };
          const awayTeam = teams.find(t => t.id === matchup.awayTeamId) || { players: [] };

          const homeScore = calculateStartingRosterWeekScore(homeTeam.players || []);
          const awayScore = calculateStartingRosterWeekScore(awayTeam.players || []);

          let homeWin = false, awayWin = false, tie = false;
          if (homeScore > awayScore) {
            homeWin = true;
          } else if (awayScore > homeScore) {
            awayWin = true;
          } else {
            tie = true;
          }

          const rHome = getRecordObj(matchup.homeTeamId);
          const rAway = getRecordObj(matchup.awayTeamId);

          rHome.points += homeScore;
          rAway.points += awayScore;

          if (homeWin) {
            rHome.wins++;
            rAway.losses++;
          } else if (awayWin) {
            rAway.wins++;
            rHome.losses++;
          } else {
            rHome.ties++;
            rAway.ties++;
          }

          txBatch.update(mDoc.ref, {
            homeScore: homeScore,
            awayScore: awayScore,
            status: "completed",
            winnerId: homeWin ? matchup.homeTeamId : (awayWin ? matchup.awayTeamId : "TIE"),
            updatedAt: Timestamp.fromMillis(Date.now())
          });
        }

        for (const [tId, rec] of Object.entries(teamRecordsUpdates)) {
          const teamRef = db.collection("fantasy_leagues").doc(leagueId).collection("teams").doc(tId);
          txBatch.update(teamRef, {
            wins: rec.wins,
            losses: rec.losses,
            ties: rec.ties,
            points: Math.round(rec.points * 100) / 100
          });
        }

        await txBatch.commit();
      }

      currentWeek++;
      await db.collection("fantasy_leagues").doc(leagueId).update({
        currentWeek: currentWeek
      });

      bounds = getWeekBounds(currentWeek);
    }

    // B. Calculate active week score up to cutoff
    const w = currentWeek;
    const liveBounds = getWeekBounds(w);

    if (liveBounds.isOffWeek) {
      console.log(`[Game Loop] Current Week ${w} is an Off Week for league ${leagueId}. No live scores to update.`);
    } else {
      console.log(`[Game Loop] Calculating live scores for Week ${w} up to cutoff ${newDate.toISOString()}`);

      const weeklyGamesSnap = await db.collection("pwhl_games").get();
      const weeklyGameIds = [];
      weeklyGamesSnap.forEach(gDoc => {
        const game = gDoc.data();
        const gDateStr = game.date_played || game.date;
        if (!gDateStr) return;
        const gDate = new Date(gDateStr);
        if (gDate >= liveBounds.start && gDate <= newDate && (game.status === "4" || game.status === "3")) {
          weeklyGameIds.push(gDoc.id.toString());
        }
      });

      const weeklySkaters = {};
      const weeklyGoalies = {};
      const getWskater = (id) => {
        if (!weeklySkaters[id]) weeklySkaters[id] = { goals: 0, assists: 0, plusMinus: 0, powerPlayPoints: 0, shortHandedPoints: 0, shotsOnGoal: 0, hits: 0, blockedShots: 0 };
        return weeklySkaters[id];
      };
      const getWgoalie = (id) => {
        if (!weeklyGoalies[id]) weeklyGoalies[id] = { wins: 0, overtimeLosses: 0, goalsAgainst: 0, shotsSaved: 0, shutouts: 0 };
        return weeklyGoalies[id];
      };

      if (weeklyGameIds.length > 0) {
        const summariesSnap = await db.collection("pwhl_game_summaries").get();
        summariesSnap.forEach(sDoc => {
          if (!weeklyGameIds.includes(sDoc.id)) return;
          const summary = sDoc.data();
          const scoringPlays = Array.isArray(summary.goals) ? summary.goals : [];
          const assistCounts = {};
          const goalCounts = {};

          scoringPlays.forEach(goal => {
            const isPP = goal.power_play === "1" || goal.power_play === 1;
            const isSH = goal.short_handed === "1" || goal.short_handed === 1;
            if (goal.goal_scorer?.player_id) {
              if (!goalCounts[goal.goal_scorer.player_id]) goalCounts[goal.goal_scorer.player_id] = { ppGoals: 0, shGoals: 0 };
              const g = goalCounts[goal.goal_scorer.player_id];
              if (isPP) g.ppGoals++;
              if (isSH) g.shGoals++;
            }
            [goal.assist1_player, goal.assist2_player].forEach(a => {
              if (!a?.player_id) return;
              if (!assistCounts[a.player_id]) assistCounts[a.player_id] = { assists: 0, ppAssists: 0, shAssists: 0 };
              const obj = assistCounts[a.player_id];
              obj.assists++;
              if (isPP) obj.ppAssists++;
              if (isSH) obj.shAssists++;
            });
          });

          // Skaters
          const homeSkaters = summary.home_team_lineup?.players || [];
          const visitorSkaters = summary.visitor_team_lineup?.players || [];
          [...homeSkaters, ...visitorSkaters].forEach(player => {
            const id = player.player_id;
            if (!id) return;
            const s = getWskater(id);
            s.goals += parseInt(player.goals || 0);
            s.pim += parseInt(player.pim || 0);
            s.shotsOnGoal += parseInt(player.shots_on || player.shots || 0);
            s.blockedShots += parseInt(player.shots_blocked_by_player || player.shots_blocked || 0);
            s.hits += parseInt(player.hits || 0);
            const pm = player.plusminus;
            if (pm !== undefined && pm !== null && pm !== "") {
              s.plusMinus += parseInt(pm, 10) || 0;
            }
            const assistObj = assistCounts[id];
            if (assistObj) {
              s.assists += assistObj.assists;
              s.powerPlayPoints += (assistObj.ppAssists || 0);
              s.shortHandedPoints += (assistObj.shAssists || 0);
            }
            const goalObj = goalCounts[id];
            if (goalObj) {
              s.powerPlayPoints += (goalObj.ppGoals || 0);
              s.shortHandedPoints += (goalObj.shGoals || 0);
            }
          });

          // Goalies
          const homeGoalies = summary.goalies?.home || [];
          const visitorGoalies = summary.goalies?.visitor || [];
          
          const gameGoaliesMap = {};
          [...homeGoalies, ...visitorGoalies].forEach(goalie => {
            const id = goalie.player_id;
            if (!id) return;
            const idStr = String(id);
            if (!gameGoaliesMap[idStr]) {
              gameGoaliesMap[idStr] = {
                saves: parseInt(goalie.saves || 0),
                goalsAgainst: parseInt(goalie.goals_against || 0),
                wins: parseInt(goalie.win || 0),
                overtimeLosses: parseInt(goalie.ot_loss || 0),
                shutouts: parseInt(goalie.shutout || 0)
              };
            } else {
              const existing = gameGoaliesMap[idStr];
              existing.saves += parseInt(goalie.saves || 0);
              existing.goalsAgainst += parseInt(goalie.goals_against || 0);
              existing.wins = Math.max(existing.wins, parseInt(goalie.win || 0));
              existing.overtimeLosses = Math.max(existing.overtimeLosses, parseInt(goalie.ot_loss || 0));
              existing.shutouts = Math.max(existing.shutouts, parseInt(goalie.shutout || 0));
            }
          });

          for (const [id, stats] of Object.entries(gameGoaliesMap)) {
            const g = getWgoalie(id);
            g.shotsSaved += stats.saves;
            g.goalsAgainst += stats.goalsAgainst;
            g.wins += stats.wins;
            g.overtimeLosses += stats.overtimeLosses;
            g.shutouts += stats.shutouts;
          }
        });
      }

      const teamsSnap = await db.collection("fantasy_leagues").doc(leagueId).collection("teams").get();
      const teams = teamsSnap.docs.map(tDoc => ({ id: tDoc.id, ...tDoc.data() }));

      const calculateStartingRosterWeekScore = (teamPlayers) => {
        const unusedIds = [...teamPlayers];
        const layoutSlots = [
          { pos: "F" }, { pos: "F" }, { pos: "F" }, { pos: "F" }, { pos: "F" }, { pos: "F" },
          { pos: "D" }, { pos: "D" }, { pos: "D" }, { pos: "D" },
          { pos: "G" }
        ];
        const starters = [];
        layoutSlots.forEach(slot => {
          const matchIdx = unusedIds.findIndex(id => {
            const mockPos = id.startsWith("pwhl_") ? (id.startsWith("pwhl_12") || id.startsWith("pwhl_13") || id.startsWith("pwhl_14") ? "G" : (id.startsWith("pwhl_8") || id.startsWith("pwhl_9") || id.startsWith("pwhl_10") || id.startsWith("pwhl_11") ? "D" : "F")) : null;
            const pos = playersPosMap[id] || mockPos || "F";
            return pos === slot.pos;
          });
          if (matchIdx !== -1) {
            starters.push(unusedIds[matchIdx]);
            unusedIds.splice(matchIdx, 1);
          }
        });

        let totalPoints = 0;
        starters.forEach(pId => {
          const skaterStats = weeklySkaters[pId];
          const goalieStats = weeklyGoalies[pId];
          const mockPos = pId.startsWith("pwhl_") ? (pId.startsWith("pwhl_12") || pId.startsWith("pwhl_13") || pId.startsWith("pwhl_14") ? "G" : (pId.startsWith("pwhl_8") || pId.startsWith("pwhl_9") || pId.startsWith("pwhl_10") || pId.startsWith("pwhl_11") ? "D" : "F")) : null;
          const pos = playersPosMap[pId] || mockPos || "F";

          let points = 0;
          if (pos === "G" && goalieStats) {
            const matrix = scoringRules.goalies || defaultScoring.goalies;
            points += (goalieStats.wins || 0) * (matrix.wins || 0);
            points += (goalieStats.overtimeLosses || 0) * (matrix.otl || 0);
            points += (goalieStats.goalsAgainst || 0) * (matrix.ga || 0);
            points += (goalieStats.shotsSaved || 0) * (matrix.saves || 0);
            points += (goalieStats.shutouts || 0) * (matrix.shutouts || 0);
          } else if (skaterStats) {
            const matrix = scoringRules.skaters || defaultScoring.skaters;
            points += (skaterStats.goals || 0) * (matrix.goals || 0);
            points += (skaterStats.assists || 0) * (matrix.assists || 0);
            points += (skaterStats.plusMinus || 0) * (matrix.plusMinus || 0);
            points += (skaterStats.powerPlayPoints || 0) * (matrix.ppp || 0);
            points += (skaterStats.shortHandedPoints || 0) * (matrix.shp || 0);
            points += (skaterStats.shotsOnGoal || 0) * (matrix.sog || 0);
            points += (skaterStats.hits || 0) * (matrix.hits || 0);
            points += (skaterStats.blockedShots || 0) * (matrix.blocks || 0);
            if (pos === "D" || pos === "Defense") {
              points += ((skaterStats.goals || 0) + (skaterStats.assists || 0)) * (matrix.defensePoints || 0);
            }
          }
          totalPoints += points;
        });

        return Math.round(totalPoints * 100) / 100;
      };

      const matchupsSnap = await db.collection("fantasy_leagues").doc(leagueId).collection("matchups").where("week", "==", w).get();
      const liveBatch = db.batch();

      for (const mDoc of matchupsSnap.docs) {
        const matchup = mDoc.data();
        const homeTeam = teams.find(t => t.id === matchup.homeTeamId) || { players: [] };
        const awayTeam = teams.find(t => t.id === matchup.awayTeamId) || { players: [] };

        const homeScore = calculateStartingRosterWeekScore(homeTeam.players || []);
        const awayScore = calculateStartingRosterWeekScore(awayTeam.players || []);

        liveBatch.update(mDoc.ref, {
          homeScore: homeScore,
          awayScore: awayScore
        });
      }
      await liveBatch.commit();
    }
  }

  return null;
});

exports.generateSeasonProjections = functions.https.onCall(async (data, context) => {
  const seasonIdStr = typeof data === "string" ? data : (data?.seasonId ? String(data.seasonId) : null);
  if (!seasonIdStr) {
    throw new functions.https.HttpsError("invalid-argument", "Missing seasonId string parameter.");
  }

  try {
    // 1. Fetch target season metadata
    const seasonDoc = await db.collection("pwhl_seasons").doc(seasonIdStr).get();
    if (!seasonDoc.exists) {
      throw new functions.https.HttpsError("not-found", `Season ${seasonIdStr} not found.`);
    }

    const targetSeason = seasonDoc.data();
    const startDateStr = targetSeason.start_date;
    const gamesPerTeam = 30; // Force 30-game regular season schedule for projections
    if (!startDateStr) {
      throw new functions.https.HttpsError("failed-precondition", `Season ${seasonIdStr} is missing start_date.`);
    }
    const targetSeasonStart = new Date(startDateStr);

    // 2. Fetch all seasons to identify historical ones
    const allSeasonsSnap = await db.collection("pwhl_seasons").get();
    const historicalSeasonIds = [];
    allSeasonsSnap.forEach(sDoc => {
      const s = sDoc.data();
      if (sDoc.id !== seasonIdStr && s.start_date) {
        const sStart = new Date(s.start_date);
        if (sStart < targetSeasonStart) {
          historicalSeasonIds.push(sDoc.id);
        }
      }
    });

    // 3. Fetch historical stats and group by player ID
    const playerHistory = {}; // playerId -> seasonId -> { seasonId, stats, position }
    if (historicalSeasonIds.length > 0) {
      const statsSnap = await db.collection("pwhl_player_stats")
        .where("season_id", "in", historicalSeasonIds)
        .get();

      statsSnap.forEach(docSnap => {
        const docData = docSnap.data();
        const pId = docData.player_id || docData.id;
        const sId = docData.season_id;
        if (!pId || !sId) return;

        if (!playerHistory[pId]) {
          playerHistory[pId] = {};
        }

        // Map flat snake_case string stats fields to camelCase numeric stats structure
        const stats = {
          gamesPlayed: Number(docData.games_played || 0),
          goals: Number(docData.goals || 0),
          assists: Number(docData.assists || 0),
          plusMinus: Number(docData.plus_minus || 0),
          powerPlayGoals: Number(docData.power_play_goals || 0),
          powerPlayAssists: Number(docData.power_play_assists || 0),
          powerPlayPoints: Number(docData.power_play_points || 0),
          shortHandedGoals: Number(docData.short_handed_goals || 0),
          shortHandedAssists: Number(docData.short_handed_assists || 0),
          shortHandedPoints: Number(docData.short_handed_points || 0),
          pim: Number(docData.penalty_minutes || docData.pim || 0),
          shotsOnGoal: Number(docData.shots || docData.shots_on || 0),
          blockedShots: Number(docData.shots_blocked_by_player || 0),
          hits: Number(docData.hits || 0),
          timeOnIce: Number(docData.ice_time || 0),
          wins: Number(docData.wins || 0),
          losses: Number(docData.losses || docData.loss || 0),
          overtimeLosses: Number(docData.ot_loss || docData.overtime_losses || 0),
          goalsAgainst: Number(docData.goals_against || 0),
          shotsSaved: Number(docData.saves || 0),
          shutouts: Number(docData.shutouts || 0),
        };

        playerHistory[pId][sId] = {
          seasonId: sId,
          stats: stats,
          position: docData.position || "F"
        };
      });
    }

    // 4. Fetch all player records for the target season
    const playersSnap = await db.collection("pwhl_players")
      .where("season_id", "in", [seasonIdStr, Number(seasonIdStr)])
      .get();
    const allPlayers = playersSnap.docs.map(doc => ({
      id: doc.id,
      data: doc.data()
    }));

    // Goalie weight and team distribution setup (Pass 1)
    const goalieWeights = {};
    const goalieTeams = {};
    const teamGoalieWeights = {};

    const prevRegularSeasons = [];
    allSeasonsSnap.forEach(sDoc => {
      const s = sDoc.data();
      const isRegular = (s.playoff === '0' || s.playoff === 0) && (s.career === '1' || s.career === 1);
      if (sDoc.id !== seasonIdStr && s.start_date && isRegular) {
        const sStart = new Date(s.start_date);
        if (sStart < targetSeasonStart) {
          prevRegularSeasons.push({ id: sDoc.id, startDate: sStart });
        }
      }
    });
    prevRegularSeasons.sort((a, b) => b.startDate - a.startDate);
    const prevSeasonId = prevRegularSeasons[0]?.id || "5";

    for (const playerDoc of allPlayers) {
      const pData = playerDoc.data;
      const playerId = pData.player_id || pData.id || playerDoc.id.split("_")[1] || playerDoc.id;
      if (!playerId) continue;

      const rawPosition = String(pData.position || pData.pos || "F").trim().toUpperCase();
      const isGoalie = rawPosition.startsWith("G") || rawPosition.includes("GOALIE");

      if (isGoalie) {
        const teamId = String(pData.team_id || pData.current_team_id || pData.latest_team_id || "FA");
        const gpLast = playerHistory[playerId]?.[prevSeasonId]?.stats?.gamesPlayed || 0;
        const weight = Math.max(gpLast, 6);

        goalieWeights[playerId] = weight;
        goalieTeams[playerId] = teamId;

        if (!teamGoalieWeights[teamId]) {
          teamGoalieWeights[teamId] = 0;
        }
        teamGoalieWeights[teamId] += weight;
      }
    }

    const defaultScoring = {
      skaters: {
        goals: 2, assists: 1, plusMinus: 0.5, ppp: 0.5, shp: 0.5, sog: 0.1, hits: 0.1, blocks: 0.5, defensePoints: 0.5
      },
      goalies: {
        wins: 4, otl: 1, ga: -2, saves: 0.2, shutouts: 3
      }
    };

    const playerProjections = [];

    for (const playerDoc of allPlayers) {
      const pData = playerDoc.data;
      const playerId = pData.player_id || pData.id || playerDoc.id.split("_")[1] || playerDoc.id;
      if (!playerId) continue;

      const rawPosition = String(pData.position || pData.pos || "F").trim();
      let position = "F";
      const upperPos = rawPosition.toUpperCase();
      if (upperPos.startsWith("G") || upperPos.includes("GOALIE")) {
        position = "G";
      } else if (upperPos.startsWith("D") || upperPos === "LD" || upperPos === "RD" || upperPos === "LHD" || upperPos === "RHD" || upperPos.includes("DEFENSE") || upperPos.includes("DEFENCE")) {
        position = "D";
      } else {
        position = "F";
      }
      if (rawPosition !== "F" && rawPosition !== "D" && rawPosition !== "G" &&
          rawPosition !== "C" && rawPosition !== "LW" && rawPosition !== "RW" &&
          rawPosition !== "LD" && rawPosition !== "RD") {
        console.log(`Normalizing raw position "${rawPosition}" to "${position}" for player ${pData.name || playerDoc.id}`);
      }
      const name = pData.name || `${pData.first_name || ""} ${pData.last_name || ""}`.trim() || "Unknown Player";

      // A. Gather valid historical seasons (exclude seasons with gamesPlayed < 5)
      const history = playerHistory[playerId] || {};
      const historyList = Object.values(history);
      const validSeasons = [];

      for (const h of historyList) {
        const sDoc = allSeasonsSnap.docs.find(d => d.id === h.seasonId);
        if (sDoc && sDoc.data().start_date) {
          const start = new Date(sDoc.data().start_date);
          if (h.stats && h.stats.gamesPlayed >= 5) {
            validSeasons.push({
              ...h,
              startDate: start
            });
          }
        }
      }

      // Sort valid seasons descending (newest first)
      validSeasons.sort((a, b) => b.startDate - a.startDate);

      const s1 = validSeasons[0];
      const s2 = validSeasons[1];

      let goalsRate = 0;
      let assistsRate = 0;
      let plusMinusRate = 0;
      let powerPlayGoalsRate = 0;
      let powerPlayAssistsRate = 0;
      let powerPlayPointsRate = 0;
      let shortHandedGoalsRate = 0;
      let shortHandedAssistsRate = 0;
      let shortHandedPointsRate = 0;
      let pimRate = 0;
      let shotsOnGoalRate = 0;
      let blockedShotsRate = 0;
      let hitsRate = 0;
      let timeOnIceRate = 0;

      let winsRate = 0;
      let lossesRate = 0;
      let overtimeLossesRate = 0;
      let shotsSavedRate = 0;
      let goalsAgainstRate = 0;
      let shutoutsRate = 0;

      const isVeteran = validSeasons.length > 0;
      let expectedGamesPlayed = 0;

      if (isVeteran) {
        // Veteran baseline metrics calculation
        const getWeightedRate = (metric) => {
          if (s1 && s2) {
            const r1 = (s1.stats[metric] || 0) / s1.stats.gamesPlayed;
            const r2 = (s2.stats[metric] || 0) / s2.stats.gamesPlayed;
            return (0.5 * r1 + 0.3 * r2) / 0.8;
          } else {
            return (s1.stats[metric] || 0) / s1.stats.gamesPlayed;
          }
        };

        if (position === "G") {
          winsRate = getWeightedRate("wins");
          lossesRate = getWeightedRate("losses");
          overtimeLossesRate = getWeightedRate("overtimeLosses");
          shotsSavedRate = getWeightedRate("shotsSaved");
          goalsAgainstRate = getWeightedRate("goalsAgainst");
          shutoutsRate = getWeightedRate("shutouts");
          timeOnIceRate = getWeightedRate("timeOnIce");
        } else {
          goalsRate = getWeightedRate("goals");
          assistsRate = getWeightedRate("assists");
          plusMinusRate = getWeightedRate("plusMinus");
          powerPlayGoalsRate = getWeightedRate("powerPlayGoals") || 0;
          powerPlayAssistsRate = getWeightedRate("powerPlayAssists") || 0;
          powerPlayPointsRate = getWeightedRate("powerPlayPoints") || (powerPlayGoalsRate + powerPlayAssistsRate);
          shortHandedGoalsRate = getWeightedRate("shortHandedGoals") || 0;
          shortHandedAssistsRate = getWeightedRate("shortHandedAssists") || 0;
          shortHandedPointsRate = getWeightedRate("shortHandedPoints") || (shortHandedGoalsRate + shortHandedAssistsRate);
          pimRate = getWeightedRate("pim");
          shotsOnGoalRate = getWeightedRate("shotsOnGoal");
          blockedShotsRate = getWeightedRate("blockedShots");
          hitsRate = getWeightedRate("hits");
          timeOnIceRate = getWeightedRate("timeOnIce");
        }

      } else {
        // Rookie Fallback Engine
        let round = 999;
        if (pData.draftInfo && pData.draftInfo.round) {
          round = parseInt(pData.draftInfo.round, 10);
        }

        let ppg = 0.15; // Replacement level baseline
        if (round === 1) {
          ppg = 0.50;
        } else if (round === 2 || round === 3) {
          ppg = 0.30;
        }

        if (position === "G") {
          let level = "low";
          if (round === 1) level = "high";
          else if (round === 2 || round === 3) level = "mid";

          if (level === "high") {
            winsRate = 0.50; lossesRate = 0.40; overtimeLossesRate = 0.10;
            shotsSavedRate = 25.5; goalsAgainstRate = 2.50; shutoutsRate = 0.05;
          } else if (level === "mid") {
            winsRate = 0.40; lossesRate = 0.50; overtimeLossesRate = 0.10;
            shotsSavedRate = 25.3; goalsAgainstRate = 2.70; shutoutsRate = 0.03;
          } else {
            winsRate = 0.30; lossesRate = 0.60; overtimeLossesRate = 0.10;
            shotsSavedRate = 25.0; goalsAgainstRate = 3.00; shutoutsRate = 0.01;
          }
          timeOnIceRate = 3600;
        } else {
          goalsRate = 0.40 * ppg;
          assistsRate = 0.60 * ppg;

          let level = "low";
          if (round === 1) level = "high";
          else if (round === 2 || round === 3) level = "mid";

          if (level === "high") {
            pimRate = 0.5; shotsOnGoalRate = 2.0; blockedShotsRate = 0.5; hitsRate = 0.8;
            powerPlayPointsRate = 0.10; powerPlayGoalsRate = 0.04; powerPlayAssistsRate = 0.06;
            shortHandedPointsRate = 0.01; shortHandedGoalsRate = 0.004; shortHandedAssistsRate = 0.006;
            timeOnIceRate = 900;
          } else if (level === "mid") {
            pimRate = 0.4; shotsOnGoalRate = 1.5; blockedShotsRate = 0.4; hitsRate = 0.6;
            powerPlayPointsRate = 0.05; powerPlayGoalsRate = 0.02; powerPlayAssistsRate = 0.03;
            shortHandedPointsRate = 0.005; shortHandedGoalsRate = 0.002; shortHandedAssistsRate = 0.003;
            timeOnIceRate = 850;
          } else {
            pimRate = 0.3; shotsOnGoalRate = 1.0; blockedShotsRate = 0.3; hitsRate = 0.4;
            powerPlayPointsRate = 0.02; powerPlayGoalsRate = 0.008; powerPlayAssistsRate = 0.012;
            shortHandedPointsRate = 0.002; shortHandedGoalsRate = 0.0008; shortHandedAssistsRate = 0.0012;
            timeOnIceRate = 780;
          }
        }
      }

      // Proportional expected games played assignment based on 30-game regular season
      if (position === "G") {
        const teamId = goalieTeams[playerId] || "FA";
        const totalWeight = teamGoalieWeights[teamId] || 6;
        const myWeight = goalieWeights[playerId] || 6;
        expectedGamesPlayed = 30 * (myWeight / totalWeight);
      } else {
        expectedGamesPlayed = 30;
      }

      // B. Aging Curve Calculation
      let age = null;
      let multiplier = 1.0;
      const birthdateStr = pData.birthdate || pData.rawbirthdate;
      if (birthdateStr) {
        const birthdate = new Date(birthdateStr);
        if (!isNaN(birthdate.getTime())) {
          age = targetSeasonStart.getFullYear() - birthdate.getFullYear();
          const m = targetSeasonStart.getMonth() - birthdate.getMonth();
          if (m < 0 || (m === 0 && targetSeasonStart.getDate() < birthdate.getDate())) {
            age--;
          }
        }
      }

      const resolvedAge = age !== null ? age : 26;
      if (resolvedAge < 24) {
        multiplier = 1.05;
      } else if (resolvedAge >= 29) {
        multiplier = 0.97;
      }

      expectedGamesPlayed = Math.max(0, Math.min(expectedGamesPlayed, gamesPerTeam));

      // C. Volumetric Extrapolation & Projections Compile
      let projected_season_stats = {};
      let projectedFPP = 0;

      if (position === "G") {
        const adjWins = winsRate * multiplier;
        const adjLosses = lossesRate / multiplier;
        const adjSaves = shotsSavedRate * multiplier;
        const adjGA = goalsAgainstRate / multiplier;
        const adjShutouts = shutoutsRate * multiplier;

        projected_season_stats = {
          gamesPlayed: Math.round(expectedGamesPlayed),
          wins: Math.round(adjWins * expectedGamesPlayed * 100) / 100,
          losses: Math.round(adjLosses * expectedGamesPlayed * 100) / 100,
          overtimeLosses: Math.round(overtimeLossesRate * expectedGamesPlayed * 100) / 100,
          shotsSaved: Math.round(adjSaves * expectedGamesPlayed * 100) / 100,
          goalsAgainst: Math.round(adjGA * expectedGamesPlayed * 100) / 100,
          shutouts: Math.round(adjShutouts * expectedGamesPlayed * 100) / 100,
          timeOnIce: Math.round(timeOnIceRate * expectedGamesPlayed)
        };

        const matrix = defaultScoring.goalies;
        let fPoints = 0;
        fPoints += projected_season_stats.wins * matrix.wins;
        fPoints += projected_season_stats.overtimeLosses * matrix.otl;
        fPoints += projected_season_stats.goalsAgainst * matrix.ga;
        fPoints += projected_season_stats.shotsSaved * matrix.saves;
        fPoints += projected_season_stats.shutouts * matrix.shutouts;
        projectedFPP = Math.round(fPoints * 100) / 100;
      } else {
        const adjGoals = goalsRate * multiplier;
        const adjAssists = assistsRate * multiplier;
        const adjPlusMinus = plusMinusRate * multiplier;
        const adjPPG = powerPlayGoalsRate * multiplier;
        const adjPPA = powerPlayAssistsRate * multiplier;
        const adjPPP = powerPlayPointsRate * multiplier;
        const adjSHG = shortHandedGoalsRate * multiplier;
        const adjSHA = shortHandedAssistsRate * multiplier;
        const adjSHP = shortHandedPointsRate * multiplier;
        const adjPim = pimRate * multiplier;
        const adjSOG = shotsOnGoalRate * multiplier;
        const adjBlocks = blockedShotsRate * multiplier;
        const adjHits = hitsRate * multiplier;

        projected_season_stats = {
          gamesPlayed: Math.round(expectedGamesPlayed),
          goals: Math.round(adjGoals * expectedGamesPlayed * 100) / 100,
          assists: Math.round(adjAssists * expectedGamesPlayed * 100) / 100,
          plusMinus: Math.round(adjPlusMinus * expectedGamesPlayed * 100) / 100,
          powerPlayGoals: Math.round(adjPPG * expectedGamesPlayed * 100) / 100,
          powerPlayAssists: Math.round(adjPPA * expectedGamesPlayed * 100) / 100,
          powerPlayPoints: Math.round(adjPPP * expectedGamesPlayed * 100) / 100,
          shortHandedGoals: Math.round(adjSHG * expectedGamesPlayed * 100) / 100,
          shortHandedAssists: Math.round(adjSHA * expectedGamesPlayed * 100) / 100,
          shortHandedPoints: Math.round(adjSHP * expectedGamesPlayed * 100) / 100,
          pim: Math.round(adjPim * expectedGamesPlayed * 100) / 100,
          shotsOnGoal: Math.round(adjSOG * expectedGamesPlayed * 100) / 100,
          blockedShots: Math.round(adjBlocks * expectedGamesPlayed * 100) / 100,
          hits: Math.round(adjHits * expectedGamesPlayed * 100) / 100,
          timeOnIce: Math.round(timeOnIceRate * expectedGamesPlayed)
        };

        const matrix = defaultScoring.skaters;
        let fPoints = 0;
        fPoints += projected_season_stats.goals * matrix.goals;
        fPoints += projected_season_stats.assists * matrix.assists;
        fPoints += projected_season_stats.plusMinus * matrix.plusMinus;

        const ppp = projected_season_stats.powerPlayPoints || (projected_season_stats.powerPlayGoals + projected_season_stats.powerPlayAssists);
        fPoints += ppp * matrix.ppp;

        const shp = projected_season_stats.shortHandedPoints || (projected_season_stats.shortHandedGoals + projected_season_stats.shortHandedAssists);
        fPoints += shp * matrix.shp;

        fPoints += projected_season_stats.shotsOnGoal * matrix.sog;
        fPoints += projected_season_stats.hits * matrix.hits;
        fPoints += projected_season_stats.blockedShots * matrix.blocks;

        if (position === "D" || position === "Defense") {
          fPoints += (projected_season_stats.goals + projected_season_stats.assists) * matrix.defensePoints;
        }
        projectedFPP = Math.round(fPoints * 100) / 100;
      }

      playerProjections.push({
        playerId: String(playerId),
        playerName: name,
        position: position,
        seasonId: seasonIdStr,
        age: age,
        expectedGamesPlayed: Math.round(expectedGamesPlayed * 100) / 100,
        projected_season_stats: projected_season_stats,
        projectedFPP: projectedFPP
      });
    }

    // 5. Positional baselines threshold determination
    const forwardsList = [];
    const defensemenList = [];
    const goaliesList = [];

    for (const p of playerProjections) {
      const pos = p.position;
      const isForward = pos === 'F' || pos === 'C' || pos === 'LW' || pos === 'RW' || pos === 'Forward';
      const isDefense = pos === 'D' || pos === 'Defense';
      const isGoalie = pos === 'G' || pos === 'Goalie';

      if (isForward) {
        forwardsList.push(p);
      } else if (isDefense) {
        defensemenList.push(p);
      } else if (isGoalie) {
        goaliesList.push(p);
      }
    }

    // Sort descending by projectedFPP to identify baselines
    forwardsList.sort((a, b) => b.projectedFPP - a.projectedFPP);
    defensemenList.sort((a, b) => b.projectedFPP - a.projectedFPP);
    goaliesList.sort((a, b) => b.projectedFPP - a.projectedFPP);

    // thresholds: 37th Forward (index 36), 25th Defenseman (index 24), 7th Goalie (index 6)
    const forwardBaseline = forwardsList[Math.min(36, forwardsList.length - 1)]?.projectedFPP || 0;
    const defenseBaseline = defensemenList[Math.min(24, defensemenList.length - 1)]?.projectedFPP || 0;
    const goalieBaseline = goaliesList[Math.min(6, goaliesList.length - 1)]?.projectedFPP || 0;

    // 6. Calculate VORP score (projectedFPP - baseline)
    for (const p of playerProjections) {
      const pos = p.position;
      const isForward = pos === 'F' || pos === 'C' || pos === 'LW' || pos === 'RW' || pos === 'Forward';
      const isDefense = pos === 'D' || pos === 'Defense';
      const isGoalie = pos === 'G' || pos === 'Goalie';

      let baseline = 0;
      if (isForward) {
        baseline = forwardBaseline;
      } else if (isDefense) {
        baseline = defenseBaseline;
      } else if (isGoalie) {
        baseline = goalieBaseline;
      }

      p.vorpScore = Math.round((p.projectedFPP - baseline) * 100) / 100;
    }

    // 7. Sort overall descending by vorpScore to assign overallRank
    playerProjections.sort((a, b) => b.vorpScore - a.vorpScore);
    playerProjections.forEach((p, index) => {
      p.overallRank = index + 1;
    });

    // 8. Assign positionalRank (arrays are already sorted descending by FPP/VORP)
    forwardsList.forEach((p, index) => {
      p.positionalRank = index + 1;
    });
    defensemenList.forEach((p, index) => {
      p.positionalRank = index + 1;
    });
    goaliesList.forEach((p, index) => {
      p.positionalRank = index + 1;
    });

    // 9. Batched Saves to Firestore
    const batchList = [];
    let currentBatch = db.batch();
    let writeCount = 0;

    for (const p of playerProjections) {
      const docRef = db.collection("pwhl_projections").doc(seasonIdStr)
        .collection("player_projections").doc(p.playerId);

      currentBatch.set(docRef, {
        playerId: p.playerId,
        playerName: p.playerName,
        position: p.position,
        seasonId: p.seasonId,
        age: p.age,
        expectedGamesPlayed: p.expectedGamesPlayed,
        projected_season_stats: p.projected_season_stats,
        projectedFPP: p.projectedFPP,
        vorpScore: p.vorpScore,
        overallRank: p.overallRank,
        positionalRank: p.positionalRank,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });

      writeCount++;
      if (writeCount === 450) {
        batchList.push(currentBatch);
        currentBatch = db.batch();
        writeCount = 0;
      }
    }

    if (writeCount > 0) {
      batchList.push(currentBatch);
    }

    // Commit batches in serial order
    for (const b of batchList) {
      await b.commit();
    }

    return {
      success: true,
      processedCount: allPlayers.length,
      batchesCommitted: batchList.length,
      baselines: {
        forward: forwardBaseline,
        defense: defenseBaseline,
        goalie: goalieBaseline
      }
    };
  } catch (err) {
    console.error("Projections generation failed:", err);
    throw new functions.https.HttpsError("internal", err.message);
  }
});


