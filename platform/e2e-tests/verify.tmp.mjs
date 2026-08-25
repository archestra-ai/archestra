import { chromium } from "@playwright/test";
const SHOT = "/tmp/claude-1001/-home-claude-archestra-platform/32172742-efb2-455b-9cda-8da4742e1055/scratchpad";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
p.setDefaultTimeout(25000);
const errs = [];
p.on("console", (m) => { if (m.type() === "error" && !m.text().includes("model is not available")) errs.push(m.text().slice(0, 200)); });

await p.goto("http://localhost:3000/chat", { waitUntil: "commit" });
await p.waitForTimeout(11000);

await p.getByTestId("locked-chat-toggle").click();
await p.waitForTimeout(500);
await p.locator('input[type="file"]').first().setInputFiles(`${SHOT}/vendor-risk-q3.txt`);
await p.waitForTimeout(1000);
const editor = p.getByTestId("chat-prompt-textarea").first();
await editor.click();
await editor.fill("Check this register please.");
await p.keyboard.press("Enter");
await p.waitForTimeout(12000);
const convId = p.url().split("/chat/")[1]?.split("?")[0];
console.log("conversation:", convId);

// Open the Files panel from the chat header
await p.locator("button, [role=tab]").filter({ hasText: /^Files$/ }).first().click();
await p.waitForTimeout(3500);
await p.screenshot({ path: `${SHOT}/r2-files-panel.png` });
const nameOnScreen = await p.getByText("vendor-risk-q3.txt").last().isVisible().catch(() => false);
console.log("filename visible in Files panel:", nameOnScreen);

// The panel row lives on the right-hand side; click its name there.
await p.locator("text=vendor-risk-q3.txt").last().click({ force: true }).catch(() => {});
await p.mouse.click(1100, 140);
await p.waitForTimeout(4000);
await p.screenshot({ path: `${SHOT}/r3-preview.png` });
const previewText = await p.getByText(/Belmont Data Systems/).first().isVisible().catch(() => false);
console.log("preview shows decrypted content:", previewText);
console.log("console errors:", errs.slice(0, 5));
await b.close();
