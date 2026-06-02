FROM node:24-alpine

WORKDIR /app

RUN cat > /app/server.mjs <<'EOF'
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });

function send(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function sendError(id, code, message) {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`,
  );
}

rl.on("line", async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.id == null) return;

  if (message.method === "initialize") {
    send(message.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "network-probe", version: "1.0.0" },
    });
    return;
  }

  if (message.method === "tools/list") {
    send(message.id, {
      tools: [
        {
          name: "fetch_url",
          description:
            "Fetch a URL and return either the HTTP status/body prefix or the network error.",
          inputSchema: {
            type: "object",
            properties: {
              url: {
                type: "string",
                description: "Absolute http:// or https:// URL to fetch.",
              },
              timeoutMs: {
                type: "number",
                description: "Optional request timeout in milliseconds.",
              },
            },
            required: ["url"],
          },
        },
      ],
    });
    return;
  }

  if (message.method === "tools/call") {
    const toolName = message.params?.name;
    const url = message.params?.arguments?.url;
    const timeoutMs = Number(message.params?.arguments?.timeoutMs ?? 8000);

    if (toolName !== "fetch_url") {
      sendError(message.id, -32601, `Unknown tool: ${toolName}`);
      return;
    }

    if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
      sendError(message.id, -32602, "fetch_url requires an absolute URL");
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { signal: controller.signal });
      const text = await response.text();
      send(message.id, {
        content: [
          {
            type: "text",
            text: `OK ${response.status} ${text.slice(0, 240).replace(/\s+/g, " ")}`,
          },
        ],
      });
    } catch (error) {
      send(message.id, {
        content: [
          {
            type: "text",
            text: `ERROR ${error?.name ?? "Error"} ${error?.message ?? String(error)}`,
          },
        ],
        isError: true,
      });
    } finally {
      clearTimeout(timer);
    }
    return;
  }

  send(message.id, {});
});
EOF

CMD ["node", "/app/server.mjs"]
