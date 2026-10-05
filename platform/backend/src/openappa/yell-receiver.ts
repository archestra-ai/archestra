import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import config from "@/config";
import logger from "@/logging";
import OpenAppaYellModel from "@/models/openappa-yell";

/**
 * The upstream reporter owns report construction and signing. Capture its exact
 * wire bytes on a short-lived loopback listener before forwarding them. The
 * capability URL belongs to one already-authorized yell, never a model argument.
 */
export async function captureYellReport<T>(params: {
  id: string;
  organizationId: string;
  send: (receiver: { port: number; token: string }) => Promise<T>;
}): Promise<T> {
  const token = randomBytes(32).toString("hex");
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== `/${token}`) {
        response.writeHead(404).end();
        return;
      }
      if (request.headers["content-encoding"] !== "gzip") {
        response.writeHead(415).end();
        return;
      }
      const archive = await readArchive(request);
      await OpenAppaYellModel.storeArchive({ ...params, archive });
      if (!config.analytics.enabled) {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ receipt_id: params.id, duplicate: false }));
        return;
      }
      // Keep the original signature and gzip; never inflate or reserialize on
      // the forwarding path. Redirects cannot send diagnostics elsewhere.
      const upstream = await fetch(REPORT_ENDPOINT, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(8000),
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip",
          "x-appa-signature": String(request.headers["x-appa-signature"] ?? ""),
        },
        body: new Uint8Array(archive),
      });
      const receipt = await upstream.text();
      response
        .writeHead(upstream.status, { "content-type": "application/json" })
        .end(receipt);
    })().catch((err: unknown) => {
      logger.warn(
        { err, yellId: params.id },
        "Could not deliver OpenAPPA report",
      );
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  server.requestTimeout = 15000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Yell receiver unavailable");
    return await params.send({ port: address.port, token });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

/** @internal exported for tests */
export const REPORT_ENDPOINT = "https://appa-yell-wkjbuewj5a-ew.a.run.app";
// Matches the upstream reporter's compressed-size ceiling.
const MAX_ARCHIVE_BYTES = 28 * 1024 * 1024;

async function readArchive(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_ARCHIVE_BYTES)
      throw new Error("Yell archive exceeds size limit");
    chunks.push(buffer);
  }
  if (size === 0) throw new Error("Yell archive is empty");
  return Buffer.concat(chunks, size);
}
