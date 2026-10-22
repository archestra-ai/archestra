import { isPlainMcpClientServerName } from "@archestra/shared/connection-setup";
import { requestOrigin } from "@/lib/request-origin";

/**
 * Agent instructions for right after connecting: a short tour of what the
 * gateway gave the agent, ending in prompts that fit what it found. The
 * Connect page hands out the prompt that points here (welcomePrompt in
 * connection/connect-page-data.ts), with `server` set to the name the client
 * registered the gateway under when the page knows it. The tour stays on the
 * gateway: agents otherwise try every MCP server they have. Other server and
 * product names stay out: the agent reads them from its own tools.
 */
export function GET(request: Request) {
  const origin = requestOrigin(request);
  const param = new URL(request.url).searchParams.get("server");
  // Only a plain name, so a crafted link cannot add text to the instructions.
  const server = param && isPlainMcpClientServerName(param) ? param : null;
  const gateway = server
    ? `In your MCP settings, the gateway is the server named \`${server}\`.`
    : `The gateway is the MCP server the user added for ${origin}. If you can't
tell which of your MCP servers that is, ask the user.`;
  return new Response(
    `# Welcome

You were just connected to the MCP gateway at ${origin}. It gives you tools
from MCP servers the user's organization runs, and may have installed shared
skills. Give the user a short guided tour. Keep the whole reply under 25 lines.

${gateway} Do not call, test, reconnect or sign in to any other MCP server,
and do not run commands that check all of your MCP servers.

0. If you have no tools from this gateway, the user isn't connected yet. Say
   so in one line and tell them to open ${origin}/connection and follow the
   setup shown for their app first. Stop there.
1. List the gateway's tools, grouped by the MCP server behind them. If tools
   load on demand, call the gateway's search_tools tool with a few broad
   queries first. One line per server: what it lets you do, in plain words.
2. List the shared skills you have from the gateway, one line each.
3. Pick the two or three of the gateway's servers that look most useful for
   this user. Make one read-only call on each, through the gateway, to find
   something real: recent channels, open pull requests, this week's tickets.
   Never send, create, edit or delete anything.
4. From what you found, suggest three to five prompts the user could paste
   next. Make them specific to what you saw, not generic.
5. If one of the gateway's servers needs the user to sign in, say which one
   and how.
6. End by asking what they want to do first.
`,
    { headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
}
