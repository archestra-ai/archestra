import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://localhost:3000/apps", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);

const apps = [
  ["Warehouse Floor Monitor", "Live bay occupancy and pick-path congestion for the Rivermouth depot.", "🏭"],
  ["Release Train Board", "Every service in the fortnightly train, with its gate status.", "🚆"],
  ["Support Queue Heatmap", "Ticket age by queue and hour, so the morning triage knows where to start.", "🔥"],
  ["Fleet Battery Status", "State of charge across the delivery fleet, refreshed every five minutes.", "🔋"],
  ["Quarterly Burn Chart", "Budget drawn down against plan, per cost centre.", "📉"],
  ["Incident Timeline", "A single scrollable timeline of the last thirty days of incidents.", "🧯"],
  ["Onboarding Checklist", "What a new joiner still has outstanding, in one place.", "🧭"],
  ["Café Occupancy — Ground Floor", "Seats free right now, updated from the door counters.", "☕"],
];
for (const [name, description, icon] of apps) {
  const res = await page.request.post("http://localhost:9000/api/apps", {
    data: { name, description, scope: "org" },
  });
  if (!res.ok()) { console.log("skip", name, res.status()); continue; }
  const app = await res.json();
  await page.request.patch(`http://localhost:9000/api/apps/${app.id}`, { data: { icon } });
  console.log("created", name);
}
await browser.close();
