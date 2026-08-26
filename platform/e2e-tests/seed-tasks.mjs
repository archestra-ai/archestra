import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://localhost:3000/a/demo-task-tracker", { waitUntil: "domcontentloaded" });
const proxy = page.frameLocator("iframe");
const app = proxy.frameLocator("iframe");
const input = app.getByPlaceholder("What needs doing?");
await input.waitFor({ timeout: 30000 });
const tasks = [
  "Re-seat the bay 4 door counter — it has been reporting zero since Tuesday",
  "Chase the Rivermouth depot for last quarter's pick-path export",
  "Rotate the staging signing key before the release train leaves",
  "Café Occupancy: confirm the ground-floor sensor mapping (табло 2)",
  "Write up the incident timeline for the 3 a.m. queue backlog",
  "Trim the onboarding checklist — three items now duplicate the handbook",
  "Ask facilities whether bay 7 is genuinely out of service or just unlit",
  "Fleet battery: add a low-charge threshold anyone can actually read",
  "Decide who owns the burn chart's cost-centre mapping from now on",
  "支店ダッシュボードの日本語ラベルを確認する",
  "Retire the old heatmap embed once the new board has run a full week",
];
for (const t of tasks) {
  await input.fill(t);
  await app.getByRole("button", { name: "Add task" }).click();
  await page.waitForTimeout(450);
}
await page.waitForTimeout(1500);
await page.screenshot({ path: "/tmp/claude-1001/-home-claude-archestra-platform/603afb71-080f-4b1b-8a3b-1e26dee9d156/scratchpad/60-seeded.png" });
console.log("seeded");
await browser.close();
