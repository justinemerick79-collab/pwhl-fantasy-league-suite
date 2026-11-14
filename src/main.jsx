import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

const dbNames = [
  "firestore/[DEFAULT]/pwhl-fantasy-mobile-26/main",
  "firestore/[DEFAULT]/pwhl-fantasy-mobile-26/offline",
  "firestore/[DEFAULT]/pwhl-fantasy-mobile-26/(default)"
];

async function init() {
  if (typeof window !== 'undefined' && window.indexedDB) {
    try {
      await Promise.all(dbNames.map(name => {
        return new Promise((resolve) => {
          const req = window.indexedDB.deleteDatabase(name);
          req.onsuccess = () => resolve();
          req.onerror = () => resolve();
          req.onblocked = () => {
            console.warn(`Deletion of local database ${name} was blocked by an open connection.`);
            resolve();
          };
        });
      }));
      console.log("🧹 Cleaned native local Firestore IndexedDB databases before App load.");
    } catch (e) {
      console.warn("Failed to delete local IndexedDB:", e);
    }
  }

  try {
    const { AuthProvider } = await import('./contexts/AuthContext.jsx');
    const { TimeTravelProvider } = await import('./contexts/TimeTravelContext.jsx');
    const { DataProvider } = await import('./contexts/DataContext.jsx');
    const { default: App } = await import('./App.jsx');

    createRoot(document.getElementById('root')).render(
      <StrictMode>
        <AuthProvider>
          <TimeTravelProvider>
            <DataProvider>
              <App />
            </DataProvider>
          </TimeTravelProvider>
        </AuthProvider>
      </StrictMode>,
    );
  } catch (err) {
    console.error("❌ App Initialization Failed:", err);
    if (typeof document !== 'undefined') {
      const rootEl = document.getElementById('root');
      if (rootEl) {
        rootEl.innerHTML = `
          <div style="padding: 24px; color: #DC2626; font-family: system-ui, -apple-system, sans-serif; background: #FEF2F2; border: 1px solid #FCA5A5; border-radius: 16px; margin: 20px; max-width: 600px; box-shadow: 0 4px 12px rgba(220, 38, 38, 0.05);">
            <h3 style="margin-top: 0; font-size: 1.1rem; font-weight: 700;">App Initialization Failed</h3>
            <p style="font-size: 0.9rem; font-weight: 500; margin: 8px 0;"><strong>Error:</strong> ${err.message || err}</p>
            <pre style="white-space: pre-wrap; font-size: 0.75rem; background: #FFF; border: 1px solid #F3F4F6; padding: 12px; border-radius: 8px; color: #4B5563; font-family: monospace; overflow-x: auto; margin-top: 12px; max-height: 300px;">${err.stack || ''}</pre>
          </div>
        `;
      }
    }
  }
}

init();
