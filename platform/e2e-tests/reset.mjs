import { chromium } from "@playwright/test";
const APP = "3c2349db-be05-4d55-9b17-3406fd5b43f0";
const b = await chromium.launch();
const p = await b.newPage();
await p.goto("http://localhost:3000/apps", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(2500);
const r = await p.request.patch(`http://localhost:9000/api/apps/${APP}`, { data: { openInFullscreen: false } });
console.log("reset", r.status());
await b.close();
