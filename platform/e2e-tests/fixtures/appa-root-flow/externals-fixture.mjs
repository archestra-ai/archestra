/**
 * The external authority and sanitizers for the live root-flow qualification.
 *
 * This is the only boundary the run mocks: a real person or a real redaction
 * service would make the approve / deny / timeout / no-answer paths untestable.
 * Everything else in the run is the real client, the real proxy, the real
 * runtime and a real provider.
 *
 * Run it, and follow the qualification, from this directory's README.md:
 *
 *   node platform/e2e-tests/fixtures/appa-root-flow/externals-fixture.mjs
 *
 * It listens on 127.0.0.1:8899 by default; `APPA_FIXTURE_PORT` overrides the
 * port, and `policy.appa.toml` must name the same one under `[externals]`.
 *
 * The runtime posts one consult envelope and reads `{version: 1, answer}` back.
 * An authority answers `{ruling: "approve" | "deny"}`; a sanitizer answers
 * `{body: <value>}`. Anything else — a slow reply, a 500, silence — is a
 * no-answer, which is what the timeout and no-answer scenarios exercise.
 *
 *   GET  /mode            read the current authority mode
 *   POST /mode {mode}     approve | deny | timeout | no_answer
 *   GET  /calls           every consult this fixture received
 */
import { createServer } from "node:http";

const PORT = Number(process.env.APPA_FIXTURE_PORT ?? 8899);
let mode = "approve";
const calls = [];

const send = (response, status, body) => {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
};

const readBody = (request) =>
  new Promise((resolve) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        resolve({});
      }
    });
  });

createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/mode" && request.method === "GET") {
    return send(response, 200, { mode });
  }
  if (url.pathname === "/mode" && request.method === "POST") {
    const body = await readBody(request);
    mode = String(body.mode ?? "approve");
    return send(response, 200, { mode });
  }
  if (url.pathname === "/calls") {
    return send(response, 200, { calls });
  }

  const consult = await readBody(request);
  calls.push({ at: new Date().toISOString(), path: url.pathname, consult, mode });

  if (url.pathname === "/authority") {
    if (mode === "timeout") {
      // Outlives the policy's `timeout_ms`, so the runtime gives up on it.
      return setTimeout(() => send(response, 200, { version: 1, answer: { ruling: "approve" } }), 30_000);
    }
    if (mode === "no_answer") {
      // A reachable authority that refuses to rule is still no answer, never a denial.
      return send(response, 503, { error: "the operator is not available" });
    }
    return send(response, 200, {
      version: 1,
      answer: { ruling: mode === "deny" ? "deny" : "approve" },
    });
  }

  // The runtime sends `{version, kind, name, declaration, artifact}`, and a
  // sanitizer's artifact carries the value as `body` — the call's arguments as
  // a JSON string for `tool_input`, the tool's output for `tool_output`.
  const body = consult?.artifact?.body ?? "";

  if (url.pathname === "/sanitizer/redact") {
    // Rewrites the call's arguments: every lab secret becomes a marker, which
    // is what lets the value move from the lab audience to `public`.
    const redacted = String(body).replaceAll(
      /LAB-SECRET-[A-Z0-9-]+/g,
      "[redacted by the redactor]",
    );
    return send(response, 200, { version: 1, answer: { body: redacted } });
  }

  if (url.pathname === "/sanitizer/summarize") {
    return send(response, 200, {
      version: 1,
      answer: {
        body: `SUMMARY(${String(body).length} characters): the report was summarized by the summarize sanitizer.`,
      },
    });
  }

  return send(response, 404, { error: "no such fixture endpoint" });
}).listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`appa fixture externals on http://127.0.0.1:${PORT}\n`);
});
