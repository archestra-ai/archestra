import { chromium } from "@playwright/test";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
p.setDefaultTimeout(25000);
await p.goto("http://localhost:3000/chat", { waitUntil: "commit" });
await p.waitForTimeout(11000);
const out = await p.evaluate(async () => {
  const log = [];
  // Tidy the sidebar: delete the throwaway chats from manual checking.
  const convs = await (await fetch("/api/chat/conversations")).json();
  const list = Array.isArray(convs) ? convs : (convs.data ?? []);
  for (const c of list) {
    await fetch(`/api/chat/conversations/${c.id}`, { method: "DELETE" });
  }
  log.push(`cleared ${list.length} chats`);
  // A project for the demo to live in.
  const proj = await (await fetch("/api/projects", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Q3 Vendor Review", description: "Third-party risk sign-off" }),
  })).json();
  log.push("project " + proj.id);
  return log;
});
console.log(out.join("\n"));
await b.close();
