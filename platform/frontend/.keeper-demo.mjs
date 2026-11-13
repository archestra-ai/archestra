// Drive the APPA Keeper on the T-2368 release-1.4 demo stack: propose a Payments API rules change and follow it.
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
const base = "http://127.0.0.1:3374";
const out = "/home/archestra/.cache/t2368-14-demo";
const keeper = "583305ef-76d7-4267-a427-db76abd7661e";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
await page.goto(`${base}/`);
await page.getByLabel(/email/i).fill("admin@example.com");
await page.getByLabel(/password/i).fill("password");
await page.getByRole("button", { name: /sign in|log in|continue/i }).first().click();
await page.waitForURL((u) => !/sign-in|login/i.test(u.toString()), { timeout: 30000 });
await page.goto(`${base}/chat?agentId=${keeper}`);
await page.waitForTimeout(4000);
await page.screenshot({ path: `${out}/demo2-00-chat.png`, fullPage: false });
const box = page.getByRole("textbox").last();
await box.click();
await box.fill(
  "Propose a Guardrails rules change for the Payments API MCP server (its MCP server id is 009f0a02-55e4-4faa-9c30-214320da3a66): exporting the ledger (payments_api__export_ledger) must require a trusted session, keeping its audience internal. Summary: Ledger exports need a trusted session. Then follow the pull request until it is done and tell me each change.",
);
await box.press("Enter");
const started = Date.now();
let n = 1;
let last = "";
while (Date.now() - started < 8 * 60_000) {
  await page.waitForTimeout(20_000);
  const text = await page.locator("main").innerText().catch(() => "");
  const tag = String(n).padStart(2, "0");
  await page.screenshot({ path: `${out}/demo2-${tag}.png`, fullPage: true });
  if (text !== last) {
    writeFileSync(`${out}/demo2-${tag}.txt`, text);
    last = text;
  }
  n += 1;
  if (/rules are (now )?active|is applied|applied\b.*rules|nothing is applied|stop(ped)? following|could not apply/i.test(text) && !/merge_pending|pulling it now/i.test(text.slice(-600))) {
    // give the Keeper one more turn to finish its sentence
    await page.waitForTimeout(10_000);
    await page.screenshot({ path: `${out}/demo2-final.png`, fullPage: true });
    writeFileSync(`${out}/demo2-final.txt`, await page.locator("main").innerText().catch(() => ""));
    break;
  }
}
await browser.close();
console.log("done after", Math.round((Date.now() - started) / 1000), "s, shots:", n - 1);
