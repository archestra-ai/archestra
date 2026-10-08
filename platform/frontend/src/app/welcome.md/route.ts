import { requestOrigin } from "@/lib/request-origin";

/**
 * Agent instructions for right after connecting: a short tour of what the
 * gateway gave the agent, ending in prompts that fit what it found. The
 * Connect page hands out the prompt that points here (welcomePrompt in
 * connection/connect-page-data.ts). Server and product names stay out: the
 * agent reads them from its own tools.
 */
export function GET(request: Request) {
  const origin = requestOrigin(request);
  return new Response(
    `# Welcome

You were just connected to the MCP gateway at ${origin}. It gives you tools
from MCP servers the user's organization runs, and may have installed shared
skills. Give the user a short guided tour. Keep the whole reply under 25 lines.

0. If you have no tools from this gateway, the user isn't connected yet. Say
   so in one line and tell them to copy the connect prompt from ${origin}/connection
   first. Stop there.
1. List the tools you have from the gateway, grouped by MCP server. If tools
   load on demand, call the gateway's search_tools tool with a few broad
   queries first. One line per server: what it lets you do, in plain words.
2. List the shared skills you have from the gateway, one line each.
3. Pick the two or three servers that look most useful for this user. Make one
   read-only call on each to find something real: recent channels, open pull
   requests, this week's tickets. Never send, create, edit or delete anything.
4. From what you found, suggest three to five prompts the user could paste
   next. Make them specific to what you saw, not generic.
5. If a server needs the user to sign in, say which one and how.
6. End by asking what they want to do first.
`,
    {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}
