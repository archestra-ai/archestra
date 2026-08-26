import { chromium } from "@playwright/test";
const S = "/tmp/claude-1001/-home-claude-archestra-platform/603afb71-080f-4b1b-8a3b-1e26dee9d156/scratchpad";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
await p.goto("http://localhost:3000/apps?settings=3c2349db-be05-4d55-9b17-3406fd5b43f0", { waitUntil: "domcontentloaded" });
await p.waitForSelector("#app-settings-open-mode", { timeout: 30000 });
await p.waitForTimeout(1200);
await p.screenshot({ path: `${S}/80-dialog-open.png` });
await b.close();
