import { chromium } from "@playwright/test";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto("http://localhost:3000/chat", { waitUntil: "commit" });
await p.waitForTimeout(11000);
const out = await p.evaluate(async () => {
  const log = [];
  const existing = await (await fetch("/api/llm-provider-api-keys")).json();
  for (const k of (Array.isArray(existing) ? existing : existing.data ?? [])) {
    if (k.provider === "anthropic") {
      const d = await fetch(`/api/llm-provider-api-keys/${k.id}`, { method: "DELETE" });
      log.push(`deleted ${k.name}: ${d.status}`);
    }
  }
  const r = await fetch("/api/llm-provider-api-keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Anthropic (demo)", provider: "anthropic",
      apiKey: "anthropic-chat-debug",
      baseUrl: "http://localhost:9092/anthropic",
      inferenceBaseUrl: "http://localhost:9092/anthropic",
      scope: "org",
    }),
  });
  log.push("created: " + r.status);
  log.push("sync: " + (await fetch("/api/llm-models/sync", { method: "POST" })).status);
  return log;
});
console.log(out.join("\n"));
await b.close();
