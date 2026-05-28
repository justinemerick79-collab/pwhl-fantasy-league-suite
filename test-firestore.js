import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs, limit, query } from "firebase/firestore";
import fs from 'fs';

const firebaseConfig = {
  projectId: "pwhl-fantasy-mobile-26",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function run() {
  const q = query(collection(db, "pwhl_teams"), limit(1));
  const snap = await getDocs(q);
  snap.forEach(doc => {
    console.log(doc.id, "=>", doc.data().season_id, typeof doc.data().season_id);
  });
  process.exit(0);
}
run();
