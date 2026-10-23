import { requestOrigin } from "@/lib/request-origin";

export function GET(request: Request) {
  const origin = requestOrigin(request);
  return new Response(
    `# Client Connection\n\nConnect your coding client to this deployment.\n\n## Setup\n\n- [Connect this client](${origin}/connect.md): Where to start setup, and the steps for agents without an installer.\n- [Welcome](${origin}/welcome.md): A guided tour of what a connected client can do.\n`,
    { headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
}
