import { chromium } from "@playwright/test";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
await p.goto("http://localhost:3000/chat/9775f32b-b4e4-4969-8882-bbcd263bd4dc", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(12000);
await p.screenshot({ path: "/tmp/claude-1001/-home-claude-archestra-platform/603afb71-080f-4b1b-8a3b-1e26dee9d156/scratchpad/70-720p.png" });
console.log(await p.locator("button").evaluateAll(ns => ns.map(n => n.getAttribute("aria-label")).filter(Boolean)));
await b.close();
