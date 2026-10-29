import { isPlainMcpClientServerName } from "@archestra/shared/connection-setup";
import { requestOrigin } from "@/lib/request-origin";

/**
 * Agent instructions for right after connecting: a short tour of what the
 * gateway gave the agent, ending in prompts that fit what it found. The
 * Connect page hands out the prompt that points here (welcomePrompt in
 * connection/connect-page-data.ts), with `server` set to the name the client
 * registered the gateway under when the page knows it. The tour stays on the
 * gateway: agents otherwise try every MCP server they have. Other server and
 * product names stay out: the agent reads them from its own tools. The tour
 * describes only what this gateway offers (its search_tools description lists
 * that): agents otherwise present another agent's tool list, or what a skill
 * describes, as things they can do, and suggest prompts that then fail.
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

You were just connected to the MCP gateway at ${origin}. It gives you the
organization's built-in tools and tools from the MCP servers it runs, and may
have installed shared skills. Give the user a short guided tour of what this
gateway gives you. Keep the whole reply under 25 lines.

${gateway} Do not call, test, reconnect or sign in to any other MCP server,
and do not run commands that check all of your MCP servers. The MCP servers
behind the gateway are part of it, not other servers: include them.

Describe only the tools this gateway gives you. An agent's tool list (from
list_agents or get_agent) shows that agent's tools, and a skill's description
shows the work it guides. Neither is a tool the gateway gives you, so do not
present them as things you can do here.

0. If you have no tools from this gateway, the user isn't connected yet. Say
   so in one line and tell them to open ${origin}/connection and follow the
   setup shown for their app first. Stop there.
1. List what the gateway gives you. If you have its search_tools tool, its
   description names the gateway's built-in capability groups and its MCP
   servers: that is the list. Otherwise, group your tools from the gateway by
   the MCP server behind them. One line per group or server: what it lets you
   do here, in plain words.
2. List the shared skills you have from the gateway, one line each. A skill
   acts only through the tools in step 1. If a skill's work needs tools that
   step 1 does not list, say so in its line.
3. Pick the two or three of the gateway's servers or capability groups that
   look most useful for this user. Make one read-only call on each, through
   the gateway, to find something real: recent channels, open pull requests,
   this week's tickets. Call only tools that search_tools returned or that are
   in your tool list. Never send, create, edit or delete anything.
4. From what you found, suggest three to five prompts the user could paste
   next. Each must work with the tools in step 1. Make them specific to what
   you saw, not generic.
5. If one of the gateway's servers needs the user to sign in, say which one
   and how.
6. End by asking what they want to do first.
`,
    { headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
}
