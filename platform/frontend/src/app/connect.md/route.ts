import {
  isInstallerClientId,
  parseConnectExclude,
} from "@archestra/shared/connection-setup";
import { deploymentTarget, requestOrigin } from "@/lib/request-origin";

/**
 * Instructions for agents without an installer (client=generic). Apps with an
 * installer, and Claude Desktop, are set up from the Connect page instead:
 * any other request gets pointed there.
 */
export function GET(request: Request) {
  const origin = requestOrigin(request);
  const params = new URL(request.url).searchParams;
  const client = params.get("client");
  return new Response(
    client === "generic"
      ? genericInstructions(origin, params)
      : connectPageInstructions(origin, client),
    {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}

function connectPageInstructions(origin: string, client: string | null) {
  const page =
    client && isInstallerClientId(client)
      ? `${origin}/connection?clientId=${client}`
      : `${origin}/connection`;
  return `# Connect This Client

Setup for ${origin} starts from its Connect page, not from this file.
Ask the user to open ${page}, pick their app, and follow the
steps shown there: a terminal command for apps with an installer, a download for
Claude Desktop, or a prompt for other agents.
Do not run an installer or change any configuration from this file.
`;
}

/**
 * For apps without a tailored installer: the agent works out what its own app
 * supports and sets up only that. The connect page's prompt names the parts
 * the user kept on the review step (`setup`), the gateway, and the connection
 * URL the user picked (`base`).
 */
function genericInstructions(origin: string, params: URLSearchParams): string {
  const { base } = deploymentTarget(origin, params.get("base"));
  const gateway = params.get("gateway");
  const exclude = new Set(parseConnectExclude(params.get("exclude")));
  const disconnectParams = new URLSearchParams({ client: "generic" });
  if (base !== `${origin}/v1`) disconnectParams.set("base", base);
  const parts: string[] = [];
  if (!exclude.has("tools") && gateway) {
    parts.push(`### Tools: MCP gateway

Gateway URL: ${base}/mcp/${gateway}
Add it as a remote MCP server over HTTP (Streamable HTTP). Prefer OAuth: the gateway
supports OAuth 2.1 with dynamic client registration, so the app signs in through the
browser the first time it connects. If the app can only send static headers, reference
an environment variable for the token in the config and ask the user to create a token
under Tools on ${origin}/connection?clientId=generic and set the variable
themselves.`);
  }
  if (!exclude.has("skills")) {
    parts.push(`### Skills: shared skills marketplace

Only if the app loads agent skills (folders with a SKILL.md) or a skills marketplace.
The marketplace is a git repository at ${origin}/skills/marketplace.git; skills live
under plugins/<marketplace>/skills/<name>/SKILL.md. Cloning needs a git credential the
user sets up themselves: point them to Install shared skills on
${origin}/connection?clientId=generic. Then clone it and register the
clone, or its skills folder, the way the app expects.`);
  }
  if (!exclude.has("proxy")) {
    parts.push(`### Model requests: LLM proxy

Only if the app lets you change its model provider's base URL. Keep the provider, model
and API key the user already has, and set the base URL to ${base}/<provider>, for
example ${base}/openai, ${base}/anthropic or ${base}/gemini. An app that speaks the
OpenAI API can instead use ${base}/model-router with provider-qualified model IDs such
as openai:gpt-5.4. Do not switch providers or models.`);
  }

  return `# Connect This App

Connect the app running this conversation to ${origin}.
${
  parts.length === 0
    ? "\nNothing was selected to set up. Ask the user to turn on a part of the setup on the connect page and copy the prompt again.\n"
    : `
## 1. Check what the app supports

Work out which app and version you are running in, then check its documentation and
config for each part below. Not every app supports every part.
Before changing anything, show the user a short table: each part, whether the app
supports it, and what you will change, including which config files you will edit.
Then stop and wait for the user's explicit yes. Change nothing until they confirm;
if they decline a part or ask for changes, follow that instead.

## 2. Set up what is supported

Back up every config file before you edit it, and keep existing entries.
Skip any part the app does not support and say so. Do not install other tools or
change unrelated settings.

${parts.join("\n\n")}

## 3. Verify and report

Reload or restart the app if it needs to. Confirm the gateway lists tools.${
        exclude.has("proxy")
          ? ""
          : " If the\nproxy was set up, send a short test prompt and confirm it still answers."
      }
Report what was set up, what was skipped and why, the config files you changed with
their backups, and how to disconnect: read
${origin}/disconnect.md?${decodeURIComponent(disconnectParams.toString())} and follow it.
`
}
Never ask the user to paste passwords, session cookies, tokens or provider keys into
this conversation, and never print a secret.
`;
}
