#!/usr/bin/env node

import { callTool, tools } from "./index.js";

const decoder = new TextDecoder();
let buffer = "";

process.stdin.on("data", (chunk) => {
  buffer += decoder.decode(chunk, { stream: true });
  drainBuffer();
});

function drainBuffer() {
  while (buffer.length > 0) {
    const message = readMessage();
    if (!message) return;
    handleMessage(message);
  }
}

function readMessage() {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd === -1) {
    const newlineEnd = buffer.indexOf("\n");
    if (newlineEnd === -1) return null;

    const line = buffer.slice(0, newlineEnd).trim();
    buffer = buffer.slice(newlineEnd + 1);
    return line ? JSON.parse(line) : null;
  }

  const header = buffer.slice(0, headerEnd);
  const match = /content-length:\s*(\d+)/i.exec(header);
  if (!match) {
    throw new Error("Missing Content-Length header");
  }

  const bodyStart = headerEnd + 4;
  const bodyLength = Number.parseInt(match[1], 10);
  const bodyEnd = bodyStart + bodyLength;
  if (buffer.length < bodyEnd) return null;

  const body = buffer.slice(bodyStart, bodyEnd);
  buffer = buffer.slice(bodyEnd);
  return JSON.parse(body);
}

function handleMessage(message) {
  try {
    if (message.method === "initialize") {
      writeResponse(message.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: {
          name: "sorting-hat-mcp",
          version: "1.2.54",
        },
      });
      return;
    }

    if (message.method === "tools/list") {
      writeResponse(message.id, { tools });
      return;
    }

    if (message.method === "tools/call") {
      const result = callTool(message.params?.name, message.params?.arguments ?? {});
      writeResponse(message.id, {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      });
      return;
    }

    if (message.id !== undefined) {
      writeError(message.id, -32601, `Unsupported method: ${message.method}`);
    }
  } catch (error) {
    writeError(message.id, -32000, error instanceof Error ? error.message : String(error));
  }
}

function writeResponse(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function writeError(id, code, message) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
}

function writeMessage(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}
