/**
 * test-admin-callables.js
 *
 * Every admin-only callable must refuse a signed-out caller and a signed-in
 * non-admin, and must still let an admin through. Admin = role 'admin' on
 * users/{uid} (the super-admin email path is not exercised here).
 *
 * Run against the emulator only:
 *   firebase emulators:start --only functions,firestore,auth
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 npx tsx test-admin-callables.js
 */
import { initializeApp } from "firebase/app";
import {
  getAuth, connectAuthEmulator, signOut,
  createUserWithEmailAndPassword, signInWithEmailAndPassword, deleteUser
} from "firebase/auth";
import { getFunctions, connectFunctionsEmulator, httpsCallable } from "firebase/functions";
import { requireEmulator, createAdminFixtures } from "./test-support.js";

const firebaseConfig = {
  projectId: "pwhl-fantasy-mobile-26",
  appId: "1:502197146749:web:48318c0fda30defd4dcd14",
  storageBucket: "pwhl-fantasy-mobile-26.firebasestorage.app",
  apiKey: "AIzaSyBUpX8nhgUOoBJABs9UNsv0j2GAVL57ZDU",
  authDomain: "pwhl-fantasy-mobile-26.firebaseapp.com",
  messagingSenderId: "502197146749"
};

requireEmulator("test-admin-callables.js");

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`);
const functions = getFunctions(app, "us-central1");
connectFunctionsEmulator(functions, "127.0.0.1", 5001);

const { doc, setDoc, deleteDoc } = createAdminFixtures(firebaseConfig.projectId, "test-admin-callables");

const ADMIN_ONLY = [
  "initializeTestEnvironment",
  "deactivateSimulation",
  "triggerSimulationDailySync",
  "generateSeasonProjections",
  "runDataSync",
];
const TEST_EMAIL = "admin_callables_temp@example.com";
const TEST_PASSWORD = "TempPassword123!";

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "✅" : "❌"} ${label}`);
  if (!ok) failures++;
};

async function errorCode(name, payload) {
  try {
    await httpsCallable(functions, name)(payload);
    return "ok";
  } catch (err) {
    return err.code;
  }
}

async function main() {
  let user = null;
  let userRef = null;
  try {
    console.log("\nSTEP 1 — signed out: every admin callable refuses");
    await signOut(auth);
    for (const name of ADMIN_ONLY) {
      const code = await errorCode(name, {});
      check(code === "functions/unauthenticated", `${name} → ${code}`);
    }

    console.log("\nSTEP 2 — signed in, not admin: every admin callable refuses");
    try {
      user = (await createUserWithEmailAndPassword(auth, TEST_EMAIL, TEST_PASSWORD)).user;
    } catch {
      user = (await signInWithEmailAndPassword(auth, TEST_EMAIL, TEST_PASSWORD)).user;
    }
    userRef = doc(null, "users", user.uid);
    await setDoc(userRef, { email: TEST_EMAIL, role: "user", isTestNode: true });
    for (const name of ADMIN_ONLY) {
      const code = await errorCode(name, {});
      check(code === "functions/permission-denied", `${name} → ${code}`);
    }

    console.log("\nSTEP 3 — admin: the check lets the call through");
    await setDoc(userRef, { role: "admin" }, { merge: true });
    // No seasonId: an admin gets past the gate and hits input validation, so no work runs.
    const projCode = await errorCode("generateSeasonProjections", {});
    check(projCode === "functions/invalid-argument", `generateSeasonProjections → ${projCode}`);
    // Runs the snapshot against the (empty) emulator database.
    const syncCode = await errorCode("triggerSimulationDailySync", {});
    check(syncCode === "ok", `triggerSimulationDailySync → ${syncCode}`);
  } finally {
    if (userRef) { try { await deleteDoc(userRef); } catch { /* fine */ } }
    if (user) { try { await deleteUser(user); } catch { /* fine */ } }
  }

  console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
