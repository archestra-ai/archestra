import { chromium } from "@playwright/test";
const b = await chromium.launch();
const p = await b.newPage();
await p.goto("http://localhost:3000/chat", { waitUntil: "commit" });
await p.waitForTimeout(11000);
const r = await p.evaluate(async () => {
  const j = await (await fetch("/api/projects")).json();
  const list = Array.isArray(j) ? j : (j.data ?? []);
  const found = list.find((x) => x.name === "Q3 Vendor Review");
  return found ? found.id : JSON.stringify(list.map((x) => x.name));
});
console.log("PROJECT:", r);
await b.close();
