/**
 * Product analytics (Firebase Analytics / Google Analytics 4).
 *
 * Rules:
 *  - `track()` never throws and never blocks the UI. If Analytics is not
 *    enabled for the project, not supported by the browser, or the manager has
 *    opted out, it does nothing.
 *  - No personal data in events: no names, emails or free text. Ids only
 *    (Firebase uid, league id), which are random.
 *  - On localhost nothing is sent unless debug mode is on
 *    (`?analyticsDebug` or localStorage.analyticsDebug = 'true'), so development
 *    clicks do not pollute beta data. Every call is still logged to the console
 *    there with `[analytics]`. Debug events carry `debug_mode` so they appear in
 *    GA DebugView.
 *  - Opt-out is per device (localStorage), set from the account menu.
 */
import { getAnalytics, isSupported, logEvent, setUserId, setAnalyticsCollectionEnabled } from 'firebase/analytics';
import { app } from '../firebase.js';

const OPT_OUT_KEY = 'pwhl_analytics_opt_out';
const isBrowser = typeof window !== 'undefined';
const isLocal = isBrowser && ['localhost', '127.0.0.1'].includes(window.location.hostname);

function readStorage(key) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

const debugOn = () => isLocal && (window.location.search.includes('analyticsDebug') || readStorage('analyticsDebug') === 'true');

export function isOptedOut() {
  return readStorage(OPT_OUT_KEY) === 'true';
}

let instancePromise = null;
function getInstance() {
  if (!instancePromise) {
    instancePromise = (async () => {
      if (!isBrowser || (isLocal && !debugOn())) return null;
      try {
        if (!(await isSupported())) return null;
        const analytics = getAnalytics(app);
        setAnalyticsCollectionEnabled(analytics, !isOptedOut());
        return analytics;
      } catch (err) {
        console.warn('[analytics] unavailable:', err?.message || err);
        return null;
      }
    })();
  }
  return instancePromise;
}

/** Log one event. `params` must hold no personal data. */
export function track(name, params = {}) {
  if (isLocal) console.debug(`[analytics] ${name}`, params);
  if (isOptedOut()) return;
  const payload = debugOn() ? { ...params, debug_mode: true } : params;
  getInstance()
    .then(analytics => { if (analytics) logEvent(analytics, name, payload); })
    .catch(() => {});
}

/** Tie later events to the signed-in manager's uid (or clear it on sign-out). */
export function identify(uid) {
  getInstance()
    .then(analytics => { if (analytics) setUserId(analytics, uid || null); })
    .catch(() => {});
}

/** Turn collection off (true) or back on (false) for this device. */
export async function setOptOut(optOut) {
  try { window.localStorage.setItem(OPT_OUT_KEY, optOut ? 'true' : 'false'); } catch { /* private mode */ }
  const analytics = await getInstance();
  if (analytics) setAnalyticsCollectionEnabled(analytics, !optOut);
}
