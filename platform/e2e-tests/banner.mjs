import { chromium } from "@playwright/test";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
await p.goto("http://localhost:3000/apps", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(5000);
const info = await p.evaluate(() => {
  const el = [...document.querySelectorAll("*")].find(n => n.textContent?.startsWith("Crab env") && n.children.length < 6);
  if (!el) return "none";
  let cur = el, path = [];
  while (cur && path.length < 6) { path.push(`${cur.tagName}#${cur.id}.${cur.className}`); cur = cur.parentElement; }
  return path;
});
console.log(info);
await b.close();
