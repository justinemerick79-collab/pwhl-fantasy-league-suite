/**
 * Shared helpers for the standalone emulator test scripts.
 *
 * Fixture setup runs through the Admin SDK, which bypasses security rules by
 * design. The client SDK cannot do this seeding and should not be able to: it
 * would mean writing another user's document and self-assigning role: "admin",
 * which firestore.rules correctly forbids. Rules are exercised by the app, not
 * by fixture setup — so never relax them to make a test pass.
 */
import { initializeApp as initAdminApp } from "firebase-admin/app";
import { getFirestore as getAdminFirestore, Timestamp } from "firebase-admin/firestore";

/**
 * Refuse to run unless the emulator hosts are set.
 *
 * These scripts create and delete documents, and both SDKs default to
 * production: the Admin SDK talks to the real database when
 * FIRESTORE_EMULATOR_HOST is unset, and the web SDK ignores that variable
 * entirely, needing an explicit connect*Emulator call. Failing loudly here is
 * the difference between a no-op and wiping real league data.
 */
export function requireEmulator(scriptName) {
  const missing = [];
  if (!process.env.FIRESTORE_EMULATOR_HOST) missing.push("FIRESTORE_EMULATOR_HOST");
  if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) missing.push("FIREBASE_AUTH_EMULATOR_HOST");
  if (missing.length === 0) return;

  console.error(`❌ ${missing.join(" and ")} not set. Refusing to run ${scriptName}.`);
  console.error("   Without them this script would create and delete documents in PRODUCTION.");
  console.error("   Start the emulators, then run:");
  console.error("     firebase emulators:start --only functions,firestore,auth");
  console.error(`     FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 npx tsx ${scriptName}`);
  process.exit(1);
}

export function emulatorHosts() {
  const [fsHost, fsPort] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080").split(":");
  return {
    firestore: { host: fsHost, port: parseInt(fsPort, 10) },
    authUrl: `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099"}`,
  };
}

/**
 * Admin-SDK fixture helpers, shimmed to read like the modular client API so the
 * call sites in these scripts stay unchanged. These are Admin SDK calls.
 */
export function createAdminFixtures(projectId, appName) {
  const adminApp = initAdminApp({ projectId }, appName);
  const adb = getAdminFirestore(adminApp);

  const wrapDoc = (d) => ({ id: d.id, ref: d.ref, data: () => d.data(), exists: () => d.exists });

  return {
    adminDb: adb,
    Timestamp,
    doc: (_db, path, id) => (id ? adb.doc(`${path}/${id}`) : adb.doc(path)),
    collection: (_db, path) => adb.collection(path),
    setDoc: (ref, data, options) => ref.set(data, options || {}),
    deleteDoc: (ref) => ref.delete(),
    getDoc: async (ref) => {
      const snap = await ref.get();
      return { exists: () => snap.exists, data: () => snap.data(), id: snap.id, ref: snap.ref };
    },
    getDocs: async (ref) => {
      const snap = await ref.get();
      const docs = snap.docs.map(wrapDoc);
      return { docs, size: snap.size, empty: snap.empty, forEach: (fn) => docs.forEach(fn) };
    },
  };
}
