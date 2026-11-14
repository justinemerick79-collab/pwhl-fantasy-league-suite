import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";
import { getStorage } from "firebase/storage";
import { getFunctions, connectFunctionsEmulator } from "firebase/functions";

const firebaseConfig = {
  projectId: "pwhl-fantasy-mobile-26",
  appId: "1:502197146749:web:48318c0fda30defd4dcd14",
  storageBucket: "pwhl-fantasy-mobile-26.firebasestorage.app",
  apiKey: "AIzaSyBUpX8nhgUOoBJABs9UNsv0j2GAVL57ZDU",
  authDomain: "pwhl-fantasy-mobile-26.firebaseapp.com",
  messagingSenderId: "502197146749"
};

const app = initializeApp(firebaseConfig);

// Note: Clean up of local Firestore IndexedDB databases is handled in main.jsx
// before importing/initializing the App to prevent connection timeouts/emulator caching races.

export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
export const functions = getFunctions(app);

// Connect to Local Functions Emulator when running on localhost AND 'useEmulator' is set in query params or localStorage.
// Otherwise, call deployed production functions to match the database configuration.
if (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
  const useEmulator = window.location.search.includes('useEmulator') || localStorage.getItem('useEmulator') === 'true';
  if (useEmulator) {
    console.log("🔌 Connecting to Local Functions Emulator...");
    connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  }
}

