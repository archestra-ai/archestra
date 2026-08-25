import { chromium } from "@playwright/test";
const SHOT = "/tmp/claude-1001/-home-claude-archestra-platform/32172742-efb2-455b-9cda-8da4742e1055/scratchpad";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
p.setDefaultTimeout(25000);
const errs = [];
p.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 150)); });

await p.goto("http://localhost:3000/apps", { waitUntil: "commit" });
await p.waitForTimeout(11000);

// Seed an app to open (scaffolded server-side, no model turn needed).
const made = await p.evaluate(async () => {
  const r = await fetch("/api/apps", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Freight Rate Explorer", description: "Compare lane rates" }),
  });
  return { status: r.status, body: (await r.text()).slice(0, 120) };
});
console.log("app:", made.status, made.body);
await p.reload({ waitUntil: "commit" });
await p.waitForTimeout(7000);
await p.screenshot({ path: `${SHOT}/a1-apps.png` });

// Open its overflow menu and look for the locked entry
// The app card's own overflow, not the sidebar's: scope to the card.
const card = p.locator("div").filter({ hasText: /^Freight Rate ExplorerCompare lane rates$/ }).first();
await card.locator("button").last().click().catch(async () => {
  await p.mouse.click(800, 691);
});
await p.waitForTimeout(1500);
await p.screenshot({ path: `${SHOT}/a2-menu.png` });
const lockedItem = p.getByText(/Open as locked chat/i).first();
const visible = await lockedItem.isVisible().catch(() => false);
console.log("'Open as locked chat' visible:", visible);
if (visible) {
  await lockedItem.click();
  await p.waitForTimeout(9000);
  console.log("navigated to:", p.url());
  await p.screenshot({ path: `${SHOT}/a3-locked-app-chat.png` });
}
console.log("errors:", errs.slice(0, 4));
await b.close();
