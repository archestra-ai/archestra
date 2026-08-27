import { chromium } from "@playwright/test";
const OUT="/tmp/claude-1001/-home-claude-archestra-platform/a158dc6d-a47a-4c02-892b-50185bb1fbf0/scratchpad";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
await p.goto("http://localhost:3000/llm/model-providers", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(9000);
await p.screenshot({ path: `${OUT}/v1280.png` });
const banner = await p.evaluate(() => {
  const el = [...document.querySelectorAll("*")].find(e => e.textContent?.startsWith("Crab env") && e.children.length < 6);
  return el ? { tag: el.tagName, cls: el.className, id: el.id, html: el.outerHTML.slice(0, 600) } : null;
});
console.log(JSON.stringify(banner, null, 1));
await b.close();
