import { chromium } from "@playwright/test";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
await p.goto("http://localhost:3000/llm/model-providers", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(6000);
console.log(await p.evaluate(() => {
  const btn = document.querySelector("main > div.sticky button");
  return { aria: btn?.getAttribute("aria-label"), text: btn?.textContent, sr: btn?.querySelector(".sr-only")?.textContent };
}));
await b.close();
