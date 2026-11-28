/**
 * Live game scoring, post-game checks, the nightly official switch, and the
 * settlement gate. See CLAUDE.md "Live scoring" and the Drive plan
 * "2026-11-28 — Plan — Live Scoring, Nightly Official Stats, Stat Corrections".
 *
 * Data:
 *   live_state/current          today's games (Pacific) and whether to poll at all
 *   game_box_scores/{gameId}    normalized per-player stats + status
 *                               'live' → 'final' (status 4 seen) → 'official' (final + stable)
 *   stat_corrections/{id}       a stat that changed AFTER the game was final (league-wide feed)
 *   daily_game_stats/{date}     day points (same shape as before), rebuilt from box scores
 *
 * Every function takes `deps.fetchSummary(gameId)` so tests can replay recorded feed data.
 */
const { Timestamp } = require("firebase-admin/firestore");
const { fetchGameSummary } = require("./hockeytech");
const { normalizeBoxScore, pointsForGame, boxHash, diffBoxScores, DEFAULT_SCORING, STAT_KEYS_SKATER, STAT_KEYS_GOALIE, round2 } = require("./boxScore");
const { pacificDateStr, addDays } = require("./dates");

const MIN = 60 * 1000;
const POST_GAME_CHECK_MIN = [15, 30, 60, 120]; // after Final; Step 0 sets the real values
const STABLE_AFTER_MIN = 30;                     // unchanged this long → stable
const STALE_MODIFIED_HOURS = 12;                 // last_modified this old → stable at once
const SETTLE_VALVE_HOURS = 24;                   // settle anyway this long after week end

const defaultDeps = { fetchSummary: fetchGameSummary };

/** Test hook: replace the feed fetch used by the scheduled jobs (emulator tests only). */
function setFetchSummaryForTests(fn) {
  defaultDeps.fetchSummary = fn || fetchGameSummary;
}

/** LeagueStat `last_modified` ("YYYY-MM-DD HH:MM:SS", league-local, treated as Eastern) → ms. */
function modifiedMs(s) {
  if (!s || typeof s !== "string") return null;
  const ms = Date.parse(`${s.replace(" ", "T")}-05:00`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Fetch one game, store its box score, and decide its status.
 * @param {object} [opts] { postCheck: true } counts this as a post-game check
 * @returns {Promise<{gameId, ok, changed, status, date, gameStatus, error?}>}
 */
async function refreshGame(db, gameId, nowMs, deps = defaultDeps, opts = {}) {
  gameId = String(gameId);
  const ref = db.collection("game_box_scores").doc(gameId);
  let summary;
  try {
    summary = await deps.fetchSummary(gameId);
  } catch (err) {
    console.error(`[Live] game ${gameId}: fetch failed:`, err.message || err);
    return { gameId, ok: false, error: String(err.message || err) };
  }
  if (!summary || !summary.meta) return { gameId, ok: false, error: "empty summary" };

  const meta = summary.meta;
  const gameStatus = String(meta.status || "");
  const isFinal = gameStatus === "4";
  const box = normalizeBoxScore(summary, { final: isFinal });
  const hash = boxHash(box);
  const lastModified = meta.last_modified || null;
  const prevSnap = await ref.get();
  const prev = prevSnap.exists ? prevSnap.data() : null;
  const changed = !prev || prev.hash !== hash;
  const now = Timestamp.fromMillis(nowMs);
  const date = prev?.date || meta.date_played || null;

  // Stability: the same data for STABLE_AFTER_MIN, or a last_modified that is long past.
  const sameAsBefore = prev && prev.hash === hash && prev.lastModified === lastModified;
  const unchangedSinceMs = sameAsBefore && prev.unchangedSince ? prev.unchangedSince.toMillis() : nowMs;
  const modMs = modifiedMs(lastModified);
  const stable = isFinal && (nowMs - unchangedSinceMs >= STABLE_AFTER_MIN * MIN ||
    (modMs !== null && nowMs - modMs >= STALE_MODIFIED_HOURS * 60 * MIN));
  const official = stable && String(meta.final) === "1";
  const status = official ? "official" : isFinal ? "final" : "live";

  const update = {
    gameId, date, seasonId: String(meta.season_id || prev?.seasonId || ""),
    status, gameStatus, metaFinal: String(meta.final ?? ""), lastModified, hash,
    fetchedAt: now,
    unchangedSince: Timestamp.fromMillis(unchangedSinceMs),
  };
  if (changed) Object.assign(update, { skaters: box.skaters, goalies: box.goalies, changedAt: now });
  if (isFinal && !prev?.finalAt) update.finalAt = now;
  if (opts.postCheck) update.postChecks = (prev?.postChecks || 0) + 1;
  if (official && prev?.status !== "official") update.officialAt = now;
  if (!official && prev?.status === "official") update.reopenedAt = now; // changed after official

  const batch = db.batch();
  batch.set(ref, update, { merge: true });

  // A stat that changes after the game was final is a correction (league-wide feed).
  if (changed && prev?.finalAt && prev.skaters) {
    for (const d of diffBoxScores({ skaters: prev.skaters, goalies: prev.goalies }, box)) {
      batch.set(db.collection("stat_corrections").doc(), {
        type: "stat", date, gameId, playerId: d.playerId, playerName: d.name, side: d.team, kind: d.kind,
        changes: d.changes, detectedAt: now, afterOfficial: prev.status === "official",
      });
    }
  }

  // Keep the schedule's status current; save the raw summary once official (that write
  // triggers the season-totals rebuild, too heavy to run on every live change).
  const gameRef = db.collection("pwhl_games").doc(gameId);
  batch.set(gameRef, { status: gameStatus }, { merge: true });
  if (official && (changed || prev?.status !== "official")) {
    batch.set(db.collection("pwhl_game_summaries").doc(gameId), { ...summary, game_id: gameId, season_id: update.seasonId }, { merge: false });
  }
  await batch.commit();
  return {
    gameId, ok: true, changed, statusChanged: prev?.status !== status, status, date, gameStatus,
    // For the app's "PWHL Games Today" panel (live_state/current).
    homeGoals: summary.totalGoals?.home ?? null, visitorGoals: summary.totalGoals?.visitor ?? null,
    period: meta.period ?? null, clock: meta.game_clock ?? null,
  };
}

/** Write live_state/current for today's Pacific date from pwhl_games. */
async function planGameDay(db, nowMs) {
  const date = pacificDateStr(nowMs);
  const snap = await db.collection("pwhl_games").where("date_played", "==", date).get();
  const games = snap.docs.map(d => {
    const g = d.data();
    return {
      gameId: String(g.game_id || d.id), startISO: g.GameDateISO8601 || null, status: String(g.status || "1"),
      home: g.home_team_code || "", visitor: g.visiting_team_code || "",
      homeGoals: g.home_goal_count ?? null, visitorGoals: g.visiting_goal_count ?? null, period: null, clock: null,
    };
  });
  const starts = games.map(g => Date.parse(g.startISO)).filter(n => !Number.isNaN(n));
  const pollFrom = starts.length ? Math.min(...starts) - 30 * MIN : null;
  const state = { date, games, active: games.length > 0, pollFrom, allStable: false, plannedAt: Timestamp.fromMillis(nowMs) };
  await db.collection("live_state").doc("current").set(state);
  console.log(`[GameDay] ${date}: ${games.length} game(s)${games.length ? `, polling from ${new Date(pollFrom).toISOString()}` : " — live poller idle"}.`);
  return state;
}

/**
 * Rebuild daily_game_stats/{date} from the stored box scores. Keeps the original
 * document shape. Does nothing if the date has no box scores (older days keep their data).
 */
async function snapshotLiveDay(db, dateStr) {
  const boxesSnap = await db.collection("game_box_scores").where("date", "==", dateStr).get();
  const boxes = boxesSnap.docs.map(d => d.data()).filter(b => b.skaters || b.goalies);
  if (boxes.length === 0) return { date: dateStr, status: "no box scores" };

  const leaguesSnap = await db.collection("fantasy_leagues").where("status", "in", ["active", "active_full"]).get();
  const leagues = leaguesSnap.docs.filter(d => !d.data().isSimulation && d.data().scoringSettings);

  const playerPoints = {};
  for (const box of boxes) {
    const pts = pointsForGame(box, DEFAULT_SCORING);
    for (const [pid, p] of Object.entries(pts)) {
      const row = (playerPoints[pid] ||= { fantasyPoints: 0, stats: {} });
      row.fantasyPoints = round2(row.fantasyPoints + p);
      const st = box.skaters?.[pid] || box.goalies?.[pid];
      const keys = box.skaters?.[pid] ? STAT_KEYS_SKATER : STAT_KEYS_GOALIE.filter(k => k !== "shotsAgainst");
      for (const k of keys) row.stats[k] = (row.stats[k] || 0) + (st[k] || 0); // two games in a day add up
    }
  }
  const leaguePoints = {};
  for (const L of leagues) {
    const out = (leaguePoints[L.id] = {});
    for (const box of boxes) {
      for (const [pid, p] of Object.entries(pointsForGame(box, L.data().scoringSettings))) out[pid] = round2((out[pid] || 0) + p);
    }
  }

  const statuses = boxes.map(b => b.status);
  const dayStatus = statuses.every(s => s === "official") ? "official" : statuses.every(s => s === "final" || s === "official") ? "final" : "live";
  const ref = db.collection("daily_game_stats").doc(dateStr);
  const existing = await ref.get();
  const prev = existing.exists ? existing.data() : {};
  await ref.set({
    date: dateStr, seasonId: boxes[0].seasonId || "", status: dayStatus,
    gamesProcessed: boxes.map(b => b.gameId),
    playerPoints,
    leaguePoints: { ...(prev.leaguePoints || {}), ...leaguePoints }, // keep simulation entries
    updatedAt: Timestamp.now(),
    version: (prev.version || 0) + 1,
  });
  return { date: dateStr, status: dayStatus, games: boxes.length, players: Object.keys(playerPoints).length, leagues: leagues.length };
}

/**
 * The 5-minute live poll. Reads one document on days without games.
 * @returns {Promise<string>} what it did
 */
async function runLivePoll(db, nowMs, deps = defaultDeps) {
  const stateRef = db.collection("live_state").doc("current");
  let snap = await stateRef.get();
  let state = snap.exists ? snap.data() : null;
  if (!state || state.date !== pacificDateStr(nowMs)) state = await planGameDay(db, nowMs); // self-heal a missed plan
  if (!state.active) return "idle: no games today";
  if (state.allStable) return "idle: all games settled";
  if (state.pollFrom && nowMs < state.pollFrom) return "idle: before first game window";

  const touchedDates = new Set();
  const results = [];
  let open = 0;
  for (const g of state.games) {
    const start = Date.parse(g.startISO);
    if (!Number.isNaN(start) && nowMs < start - 30 * MIN) { open++; continue; }
    const boxSnap = await db.collection("game_box_scores").doc(g.gameId).get();
    const box = boxSnap.exists ? boxSnap.data() : null;
    if (box?.status === "official") continue;
    let due, postCheck = false;
    if (!box || box.status !== "final") {
      due = true;
    } else {
      const done = box.postChecks || 0;
      if (done < POST_GAME_CHECK_MIN.length) {
        due = nowMs >= box.finalAt.toMillis() + POST_GAME_CHECK_MIN[done] * MIN;
        postCheck = due;
      } else {
        continue; // checks used up; the nightly switch takes over
      }
    }
    if (!due) { open++; continue; }
    const r = await refreshGame(db, g.gameId, nowMs, deps, { postCheck });
    results.push(r);
    if (r.ok && (r.changed || r.statusChanged) && r.date) touchedDates.add(r.date); // day status follows game status
    if (r.ok) Object.assign(g, { status: r.gameStatus, homeGoals: r.homeGoals, visitorGoals: r.visitorGoals, period: r.period, clock: r.clock });
    const finished = r.ok && (r.status === "official" || (r.status === "final" && (box?.postChecks || 0) + (postCheck ? 1 : 0) >= POST_GAME_CHECK_MIN.length));
    if (!finished) open++;
  }
  for (const d of touchedDates) await snapshotLiveDay(db, d);
  await stateRef.set({ games: state.games, allStable: open === 0, lastPollAt: Timestamp.fromMillis(nowMs) }, { merge: true });
  return `polled ${results.length} game(s), ${results.filter(r => r.changed).length} changed, ${open} still open`;
}

/** Nightly: re-check every game of the last 3 Pacific days; mark official; log corrections. */
async function reconcileRecentGames(db, nowMs, deps = defaultDeps, days = 3) {
  const today = pacificDateStr(nowMs);
  const dates = Array.from({ length: days }, (_, i) => addDays(today, -(i + 1)));
  const snap = await db.collection("pwhl_games").where("date_played", "in", dates).get();
  const touched = new Set();
  const out = [];
  for (const d of snap.docs) {
    const r = await refreshGame(db, d.data().game_id || d.id, nowMs, deps);
    out.push(r);
    if (r.ok && r.date) touched.add(r.date);
  }
  for (const date of touched) await snapshotLiveDay(db, date);
  console.log(`[Reconcile] ${dates.join(", ")}: ${out.length} game(s); official ${out.filter(r => r.status === "official").length}; changed ${out.filter(r => r.changed).length}; errors ${out.filter(r => !r.ok).length}.`);
  return out;
}

/**
 * Settlement gate: every game of the week must be official. Re-checks the rest now.
 * @returns {Promise<{ok: boolean, pending: string[]}>}
 */
async function ensureWeekOfficial(db, weekInfo, nowMs, deps = defaultDeps) {
  const ids = (weekInfo.games || []).map(String);
  const pending = [];
  const touched = new Set();
  for (const id of ids) {
    const box = await db.collection("game_box_scores").doc(id).get();
    if (box.exists && box.data().status === "official") continue;
    const r = await refreshGame(db, id, nowMs, deps);
    if (r.ok && r.date) touched.add(r.date);
    if (!(r.ok && r.status === "official")) pending.push(id);
  }
  for (const date of touched) await snapshotLiveDay(db, date);
  return { ok: pending.length === 0, pending };
}

module.exports = {
  refreshGame, planGameDay, runLivePoll, snapshotLiveDay, reconcileRecentGames, ensureWeekOfficial,
  POST_GAME_CHECK_MIN, STABLE_AFTER_MIN, SETTLE_VALVE_HOURS, modifiedMs, setFetchSummaryForTests,
};
