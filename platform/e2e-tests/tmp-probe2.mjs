import { chromium } from "@playwright/test";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
await p.goto("http://localhost:3000/", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(7000);
await p.goto("http://localhost:3000/mcp/registry", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(5000);
console.log("registry rows:", await p.locator('a:has-text("Orbit Tracker MCP")').count());
console.log("row html:", (await p.locator('a:has-text("Orbit Tracker MCP")').first().evaluate(e => e.outerHTML).catch(() => "n/a")).slice(0, 200));
await p.goto("http://localhost:3000/mcp/registry/196a6550-acb3-458d-8d9e-6d1f3fbbe23e", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(6000);
for (const sel of ['a[href*="tab=inspector"]', 'text=Inspector', 'text=Personal connections', 'text=Private to its owner']) {
  console.log(sel, "->", await p.locator(sel).count());
}
console.log("tab html:", (await p.locator('text=Inspector').first().evaluate(e => e.outerHTML).catch(() => "n/a")).slice(0, 250));
await b.close();
