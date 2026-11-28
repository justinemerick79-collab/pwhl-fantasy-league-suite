/**
 * HockeyTech / LeagueStat feed access, shared by every server path.
 * (Replaces the private copy that functions/livePoller.js used to carry.)
 */
const API_KEY = "446521baf8c38984";
const CLIENT_CODE = "pwhl";
const BASE_URL = "https://lscluster.hockeytech.com/feed/index.php";

async function fetchFromApi(params) {
  const url = new URL(BASE_URL);
  url.searchParams.append("key", API_KEY);
  url.searchParams.append("client_code", CLIENT_CODE);
  url.searchParams.append("fmt", "json");
  for (const [k, v] of Object.entries(params)) url.searchParams.append(k, v);
  const response = await fetch(url.toString());
  if (!response.ok) throw new Error(`HockeyTech API fetch failed: ${response.status} ${response.statusText}`);
  const text = await response.text();
  // The feed sometimes wraps JSON in a JSONP callback.
  const m = text.match(/^[^{[]*([{[].*[}\]])[^}\]]*$/s);
  return JSON.parse(m ? m[1] : text);
}

/** The game summary itself (`GC.Gamesummary`), or null. */
async function fetchGameSummary(gameId) {
  const data = await fetchFromApi({ feed: "gc", tab: "gamesummary", game_id: String(gameId), site_id: "0", lang: "en" });
  return data?.GC?.Gamesummary || null;
}

module.exports = { fetchFromApi, fetchGameSummary };
