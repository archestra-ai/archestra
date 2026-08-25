import { chromium } from "@playwright/test";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
p.setDefaultTimeout(20000);
await p.goto("http://localhost:3000/chat", { waitUntil: "commit" });
await p.waitForTimeout(11000);
await p.getByTestId("locked-chat-toggle").click();
await p.waitForTimeout(600);
// Drive the real <input type=file> the way the page's own picker would.
const ok = await p.evaluate(() => {
  const input = document.querySelector('input[type="file"]');
  if (!input) return "no input";
  const file = new File(
    ["Vendor risk register - Q3\nBelmont Data Systems: pen-test overdue 41 days\n"],
    "vendor-risk-q3.txt",
    { type: "text/plain" },
  );
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return "dispatched";
});
console.log("js upload:", ok);
await p.waitForTimeout(2500);
console.log("chip visible:", await p.getByText("vendor-risk-q3.txt").first().isVisible().catch(() => false));
await b.close();
