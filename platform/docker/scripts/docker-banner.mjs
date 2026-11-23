// The one-shot startup banner of supervisor.mjs: the frontend and backend URLs
// and where to get help, printed once both servers answer so it lands after
// the startup logs instead of in the middle of them.
//
// It gives up waiting after BANNER_WAIT_MS and prints anyway: the banner is
// informational and must not depend on a healthy boot. The backend counts as
// up once /ready answers, even with 503 and `"kubernetes":"starting"`: in
// quickstart mode /ready also waits for the embedded cluster, while the UI is
// usable earlier. (/health is no signal: a placeholder server answers it while
// the backend still seeds.)

import { setTimeout as sleep } from "node:timers/promises";

const BANNER_WAIT_MS = 180_000;
const SETTLE_MS = 5_000;

const env = process.env;
const frontendUrl = env.ARCHESTRA_FRONTEND_URL || "http://localhost:3000";
const backendUrl = env.ARCHESTRA_INTERNAL_API_BASE_URL || "http://localhost:9000";
// The backend brings up the ngrok tunnel in-process. With a reserved domain the
// public URL is known up front; with an ephemeral one it is only known once the
// tunnel connects (logged by the backend, and shown on the MS Teams setup page).
const tunnelUrl = env.ARCHESTRA_NGROK_DOMAIN ? `https://${env.ARCHESTRA_NGROK_DOMAIN}` : "";

const deadline = Date.now() + BANNER_WAIT_MS;
while (Date.now() < deadline) {
  if ((await backendUp()) && (await answers("http://127.0.0.1:3000/default-favicon.ico"))) break;
  await sleep(2_000);
}
// The backend keeps logging one-off startup work for a few seconds after it
// starts answering; let that settle so it doesn't push the banner off screen.
await sleep(SETTLE_MS);

const green = "\x1b[0;32m";
const blue = "\x1b[0;34m";
const cyan = "\x1b[1;36m";
const bold = "\x1b[1m";
const reset = "\x1b[0m";
// Sized to the terminal; 80 columns without one (e.g. `docker logs`).
const columns = Math.max(40, process.stdout.columns || Number(env.COLUMNS) || 80);
const bar = `${cyan}${"═".repeat(columns)}${reset}`;

const lines = [
  "",
  bar,
  "",
  `${green}  Welcome to Archestra! <3 ${reset}`,
  "",
  `   > ${bold}Frontend:${reset} ${frontendUrl}`,
  `   > ${bold}Backend:${reset}  ${backendUrl}`,
];
if (tunnelUrl) {
  lines.push(
    `   > ${bold}Tunnel:${reset}   ${tunnelUrl}`,
    "",
    `   ${blue}${bold}MS Teams Webhook:${reset} ${blue}${tunnelUrl}/api/webhooks/chatops/ms-teams${reset}`,
    "   (Set this as the Messaging Endpoint in your Azure Bot Configuration)",
  );
} else if (env.ARCHESTRA_NGROK_AUTH_TOKEN) {
  lines.push(
    `   > ${bold}Tunnel:${reset}   starting ngrok... (public URL appears on the MS Teams setup page once connected)`,
  );
}
lines.push(
  "",
  "   Our team is working hard to make Archestra great for you!",
  "   Please reach out with any questions, requests, or feedback.",
  "",
  `   ${blue}Slack Community:${reset} https://archestra.ai/join-slack`,
  `   ${blue}Give us a star on GitHub:${reset} https://github.com/archestra-ai/archestra`,
  "",
  bar,
  "",
);
process.stdout.write(`${lines.join("\n")}\n`);

async function backendUp() {
  try {
    const response = await fetch(`${backendUrl}/ready`, { signal: AbortSignal.timeout(5_000) });
    const body = await response.text();
    return response.status === 200 || (response.status === 503 && body.includes('"kubernetes":"starting"'));
  } catch {
    return false;
  }
}

async function answers(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(5_000) })).ok;
  } catch {
    return false;
  }
}
