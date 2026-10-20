// Logs a role in through the sign-in page and stores its Playwright storage state in the run.
// Usage: node login.mjs --run <runDir> --role member --email qa-member@example.invalid
//        (password from ARCHESTRA_QA_PASSWORD, or --password-file <file>)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest, parseArgs, playwright, saveManifest } from "./lib.mjs";

const DEV_ADMIN_PASSWORD = "password"; // platform/shared/consts.ts DEFAULT_ADMIN_PASSWORD

export async function login(manifest, { role, email, password }) {
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(manifest.baseUrl);
  const secret = password ?? (role === "admin" && isLocal ? DEV_ADMIN_PASSWORD : undefined);
  if (!secret) throw new Error(`No password for role ${role}; set ARCHESTRA_QA_PASSWORD or --password-file`);

  const { chromium } = playwright();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ baseURL: manifest.baseUrl });
    await page.goto("/auth/sign-in");
    await page.getByLabel(/email/i).fill(email);
    await page.getByLabel(/password/i).first().fill(secret);
    await page.getByRole("button", { name: /sign in|log in|login/i }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/auth"), { timeout: 30_000 });
    const state = path.join("state", `${role}.json`);
    fs.mkdirSync(path.join(manifest.runDir, "state"), { recursive: true });
    await page.context().storageState({ path: path.join(manifest.runDir, state) });
    manifest.roles[role] = { email, state };
    saveManifest(manifest);
    console.log(`logged in ${role} (${email}) → ${state}`);
  } finally {
    await browser.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs();
  const password = args["password-file"] ? fs.readFileSync(args["password-file"], "utf8").trim() : process.env.ARCHESTRA_QA_PASSWORD;
  await login(loadManifest(args.run), { role: args.role, email: args.email, password });
}
