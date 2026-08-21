import { chromium } from "@playwright/test";
const b = await chromium.launch();
const p = await (await b.newContext()).newPage();
await p.goto("http://localhost:3000/llm/costs", { waitUntil: "domcontentloaded", timeout: 60000 });
await p.waitForTimeout(8000);
const who = await p.evaluate(async () => {
  const r = await fetch("/api/auth/get-session", { credentials: "include" });
  return r.ok ? await r.text() : `status ${r.status}`;
});
console.log(who.slice(0, 400));
await b.close();
