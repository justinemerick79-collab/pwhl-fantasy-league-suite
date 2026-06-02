const functions = require("firebase-functions");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
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

        // B. Ingest player stats data (Top Scorers)
        console.log(`[Stats Sync] Fetching top scorers for season ${seasonId}...`);
        const statsData = await fetchFromApi({ 
          feed: 'modulekit', 
          view: 'statviewtype', 
          type: 'topscorers', 
          season_id: seasonId, 
          first: 0, 
          limit: 500 
        });
        const stats = statsData?.SiteKit?.Statviewtype || [];

        count = 0;
        currentBatch = db.batch();

        for (const stat of stats) {
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
  try {
    const envRef = db.collection("admin_settings").doc("environment");
    const envSnap = await envRef.get();
    
    if (envSnap.exists) {
      const envData = envSnap.data();
      if (envData.time_travel_mode === true) {
        const rawDate = envData.simulated_date || envData.current_system_date;
        if (rawDate) {
          console.log(`[Time Travel] Active in admin_settings/environment. Cutoff: ${rawDate}`);
          return new Date(rawDate);
        }
      }
    }
  } catch (err) {
    console.error("Error reading admin_settings/environment:", err);
  }
  
  try {
    const ttRef = db.collection("app_settings").doc("time_travel");
    const ttSnap = await ttRef.get();
    if (ttSnap.exists) {
      const ttData = ttSnap.data();
      if (ttData.enabled && ttData.date) {
        console.log(`[Time Travel] Active in app_settings/time_travel. Cutoff: ${ttData.date}`);
        return new Date(`${ttData.date}T08:00:00-08:00`);
      }
    }
  } catch (err) {
    console.error("Error reading app_settings/time_travel:", err);
  }
  
  return new Date(await getSystemDate());
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

  // 2. Fetch all games for this season to determine which are Final BEFORE cutoff
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

  console.log(`Found ${pastGameIds.size} completed games prior to cutoff: ${cutoffDate.toISOString()}`);

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
        goalieList.forEach(goalie => {
          const id = goalie.player_id;
          if (!id) return;
          const g = getGoalieObj(id);
          g.gamesPlayed += 1;
          g.shotsSaved += parseInt(goalie.saves || 0);
          g.goalsAgainst += parseInt(goalie.goals_against || 0);
          g.wins += parseInt(goalie.win || 0);
          g.losses += parseInt(goalie.loss || 0);
          g.overtimeLosses += parseInt(goalie.ot_loss || 0);
          g.shutouts += parseInt(goalie.shutout || 0);

          const secs = parseInt(goalie.seconds || goalie.secs || 0);
          g.timeOnIce += secs;
        });
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

  // 3. Fetch players reference to map metadata (name, team, position)
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

  console.log(`Fetched ${Object.keys(playersMap).length} player profiles for mapping.`);

  // 4. Fetch all active fantasy leagues to compute custom scoring values
  const leaguesSnap = await db.collection("fantasy_leagues").get();
  console.log(`Found ${leaguesSnap.size} active leagues to crunch fantasy points for.`);

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

  // Create list of scoring contexts including active leagues + a 'global' default scoring context
  const scoringContexts = leaguesSnap.docs.map(docSnap => ({
    id: docSnap.id,
    scoring: docSnap.data().scoringSettings || defaultScoring
  }));
  
  // Add global default fallback context
  scoringContexts.push({ id: "global", scoring: defaultScoring });

  // Use simulated mock date for updatedAt via central getSystemDate clock
  const systemTimeMs = await getSystemDate();
  const timestampValue = admin.firestore.Timestamp.fromMillis(systemTimeMs);

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

      // Defensemen extra bonus
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

  console.log(`Successfully aggregated and crunched player stats for season ${seasonIdStr} across ${scoringContexts.length} scoring contexts!`);
  return null;
});

/**
 * HTTPS Callable Cloud Function to initialize the QA Simulation Sandbox.
 * Automatically provisions a test sandbox consisting of 7 bot users,
 * an active 8-team filled league, 8 team sheets, and a 7-week matchup schedule.
 */
exports.initializeTestEnvironment = functions.https.onCall(async (data, context) => {
  // 1. Enforce user authentication
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "The function must be called by an authenticated user."
    );
  }

  const adminUid = context.auth.uid;

  // 2. Enforce admin privilege check
  const userRef = db.collection("users").doc(adminUid);
  const userSnap = await userRef.get();
  if (!userSnap.exists || userSnap.data().role !== "admin") {
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
  const systemTimeMs = await getSystemDate();
  const systemTimestamp = admin.firestore.Timestamp.fromMillis(systemTimeMs);

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

  // D. Create filled League document (active_full)
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
    createdAt: systemTimestamp,
    rosterSettings: defaultRosterSettings,
    scoringSettings: defaultScoringSettings,
    scheduleSettings: defaultScheduleSettings,
    waiverOrder: [adminTeamRef.id, ...botTeamRefs.map(r => r.id)]
  });

  // E. Generate mathematically perfect Weekly H2H Matchups (Circle Rotation, Double Round-Robin for 14 weeks)
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
    const weekNum1 = round + 1;
    const weekNum2 = round + 8;
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
});

