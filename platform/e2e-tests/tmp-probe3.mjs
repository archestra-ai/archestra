import { chromium } from "@playwright/test";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
await p.goto("http://localhost:3000/", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(7000);
await p.goto("http://localhost:3000/mcp/registry", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(6000);
for (const sel of ['text=Orbit Tracker MCP', '[data-testid]']) {
  console.log(sel, "->", await p.locator(sel).count());
}
const h = await p.locator('text=Orbit Tracker MCP').first().evaluate(e => e.outerHTML).catch(e => String(e));
console.log("el:", h.slice(0, 300));
const parent = await p.locator('text=Orbit Tracker MCP').first().evaluate(e => e.closest('a,tr,button')?.outerHTML ?? "no ancestor").catch(e => String(e));
console.log("ancestor:", parent.slice(0, 300));
await b.close();
