import { chromium } from "@playwright/test";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
await p.goto("http://localhost:3000/apps", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(5000);
const dismiss = p.getByRole("button", { name: /Dismiss notification/i }).first();
if (await dismiss.count()) { await dismiss.click(); console.log("dismissed"); }
await p.waitForTimeout(1500);
const portal = await p.evaluate(() => [...document.querySelectorAll("body > *")].map(n => n.tagName + "#" + n.id));
console.log(portal);
const state = await p.context().storageState();
await b.close();
console.log(JSON.stringify(state.origins?.[0]?.localStorage?.map(x => x.name) ?? []));
