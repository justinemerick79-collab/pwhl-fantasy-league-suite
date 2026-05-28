import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, deleteDoc, doc } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: import.meta.env ? import.meta.env.VITE_FIREBASE_API_KEY : process.env.VITE_FIREBASE_API_KEY,
  authDomain: "pwhl-fantasy-mobile-26.firebaseapp.com",
  projectId: "pwhl-fantasy-mobile-26",
  storageBucket: "pwhl-fantasy-mobile-26.firebasestorage.app",
  messagingSenderId: "148303038668",
  appId: "1:148303038668:web:75db95f2d1e2e137452d3d"
};

// We will just run this through a quick vite node script or directly if we use dotenv
// Since we are running in node, import.meta.env might fail, so let's use dotenv or just run it via browser manually.
