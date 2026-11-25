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

// BANNER_WAIT_SECONDS=0 prints at once, to look at the banner from a checkout.
const BANNER_WAIT_MS = Number(process.env.BANNER_WAIT_SECONDS ?? 180) * 1_000;
const SETTLE_MS = BANNER_WAIT_MS > 0 ? 5_000 : 0;

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

// The Archestra mark, 30 columns by 14 rows. Quarter-block characters put four
// pixels in a cell, so the diagonals step half a column at a time instead of a
// whole one. A terminal narrower than the mark goes without it.
const LOGO = [
  "               ▄████▙▖",
  "              ▟███▜███▖",
  "             ▟███▘ ▜███▖",
  "            ▟███▘   ▜███▖",
  "           ▐███▌     ▜███▖",
  "            ▜███▖     ▜███▖",
  "             ▜███▖     ▜███▖",
  "              ███▙      ▜███▖",
  "        ▄▄▄▄▄▟███▌       ▜███▖",
  "      ▟████████▛▘         ▜███▖",
  "     ▟███▘                 ▜███▖",
  "    ▟███▘                   ▜██▙",
  "   ▟███▘        ▗▄▄▄▄▄▄▄▄▄▄▄███▛",
  "  ▟███▘         ▐█████████████▀",
];

const lines = ["", bar, ""];
if (columns >= 34) {
  lines.push(...LOGO.map((row) => `${bold}${row}${reset}`), "");
}
lines.push(
  `  ${green}${bold}Welcome to Archestra!${reset}`,
  "",
  `  ${bold}Open${reset}    ${cyan}${frontendUrl}${reset}`,
);
if (tunnelUrl) {
  lines.push(
    `  ${bold}Tunnel${reset}  ${cyan}${tunnelUrl}${reset}`,
    "",
    `  ${bold}MS Teams webhook${reset}  ${cyan}${tunnelUrl}/api/webhooks/chatops/ms-teams${reset}`,
    "  (Set this as the Messaging Endpoint in your Azure Bot Configuration)",
  );
} else if (env.ARCHESTRA_NGROK_AUTH_TOKEN) {
  lines.push(
    `  ${bold}Tunnel${reset}  starting ngrok... (public URL appears on the MS Teams setup page once connected)`,
  );
}
lines.push(
  "",
  "  Our team is working hard to make Archestra great for you!",
  "  Please reach out with any questions, requests, or feedback.",
  "",
  `  ${bold}Slack${reset}   ${blue}https://archestra.ai/join-slack${reset}`,
  `  ${bold}GitHub${reset}  ${blue}https://github.com/archestra-ai/archestra${reset}  (a star helps)`,
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
