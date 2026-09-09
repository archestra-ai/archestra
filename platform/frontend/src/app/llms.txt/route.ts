export function GET(request: Request) {
  const origin = new URL(request.url).origin;
  return new Response(
    `# Client Connection\n\nConnect your coding client to this deployment.\n\n## Setup\n\n- [Connect this client](${origin}/connect.md): Public instructions for browser-approved client setup.\n`,
    { headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
}
