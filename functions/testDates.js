// Mirror frontend's parseDateStr
const parseDateStr = (dateStr) => {
  if (!dateStr) return new Date();
  if (dateStr.includes('T') || dateStr.includes(' ')) return new Date(dateStr);
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
};

function getLocalDateStr(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function run() {
  const weekStartStr = "2025-11-17"; // Monday
  
  // Browser standard: new Date("2025-11-17")
  const weekStartUTC = new Date(weekStartStr);
  console.log("weekStartUTC (ISO):", weekStartUTC.toISOString());
  console.log("weekStartUTC (Local):", weekStartUTC.toString());
  
  // Safe parser: parseDateStr(weekStartStr)
  const weekStartSafe = parseDateStr(weekStartStr);
  console.log("weekStartSafe (ISO):", weekStartSafe.toISOString());
  console.log("weekStartSafe (Local):", weekStartSafe.toString());
  
  // Generating days using UTC-shifted date
  console.log("\n--- Days generated with standard new Date(weekStartStr) ---");
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStartUTC);
    d.setDate(weekStartUTC.getDate() + i);
    const dStr = getLocalDateStr(d);
    const label = d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' });
    console.log(`Day ${i}: dateStr=${dStr}, label=${label}, actualLocal=${d.toString()}`);
  }
  
  // Generating days using Safe Parser
  console.log("\n--- Days generated with Safe Parser parseDateStr(weekStartStr) ---");
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStartSafe);
    d.setDate(weekStartSafe.getDate() + i);
    const dStr = getLocalDateStr(d);
    const label = d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' });
    console.log(`Day ${i}: dateStr=${dStr}, label=${label}, actualLocal=${d.toString()}`);
  }
}

run();
