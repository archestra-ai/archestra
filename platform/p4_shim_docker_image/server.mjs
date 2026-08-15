// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

// The p4 shim server: executes an allowlisted set of Perforce CLI commands on
// behalf of the Archestra backend, which reaches it over the in-cluster
// Service. Security model (defense in depth, outermost first):
//
// 1. NetworkPolicy — ingress only from platform backend/worker pods, egress
//    only to the customer's Perforce server (applied by the runtime manager).
// 2. Bearer token — minted per-deployment by the runtime manager, delivered
//    via a Secret; every endpoint except /healthz requires it.
// 3. Command allowlist — only the read-side administrative commands the
//    permission sync needs; per-command flag allowlists; no shell anywhere
//    (execFile with argv arrays).
// 4. Statelessness — credentials arrive per request and are passed to `p4`
//    via environment/stdin, never argv (argv is visible in /proc); nothing is
//    persisted beyond the pod-lifetime /work emptyDir.
//
// The `p4` binary itself is NOT in the image: the backend pushes a
// checksum-verified binary to PUT /p4-binary at provision time (see the
// Dockerfile header for why).

import { spawn } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { chmodSync, createWriteStream, existsSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8080);
const WORK_DIR = process.env.P4_SHIM_WORK_DIR ?? "/work";
const P4_BINARY = `${WORK_DIR}/p4`;
const P4_TICKETS = `${WORK_DIR}/.p4tickets`;
const MAX_EXEC_BODY_BYTES = 1024 * 1024;
const MAX_BINARY_BYTES = 256 * 1024 * 1024;
// Comfortably under the pod's 256Mi limit, because this guard is only useful
// if it can fire BEFORE the container dies. Output accumulates as a JS string
// (two bytes per character) and is then serialized into a JSON response, so a
// 64MiB ceiling needed several times that in headroom and the kernel always
// won the race — a runaway command OOM-killed the pod instead of returning
// this error.
const MAX_OUTPUT_BYTES = 24 * 1024 * 1024;
const EXEC_TIMEOUT_MS = 60_000;
const MAX_CONCURRENT_EXECS = 8;

/**
 * The complete command surface. Flags not listed here are rejected, as is any
 * command not listed. `trust` is internal-only (run automatically for ssl:
 * targets), never callable by the client.
 */
const COMMAND_ALLOWLIST = {
  info: new Set(),
  login: new Set(["-a", "-p", "-s"]),
  protects: new Set(["-a"]),
  groups: new Set(),
  group: new Set(["-o"]),
  users: new Set(["-a"]),
};

const token = loadToken();
let inFlight = 0;
const trustedPorts = new Set();

// A restarted pod must not inherit a ticket from whatever wrote /work before.
discardStoredTickets();

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/healthz") {
      // Liveness for the kubelet, and nothing else: whether this pod holds a
      // p4 binary, and which architecture it is, are facts about the
      // deployment that an unauthenticated caller has no business reading.
      return sendJson(response, 200, { ok: true });
    }
    if (!isAuthorized(request)) {
      return sendJson(response, 401, { error: "unauthorized" });
    }
    if (request.method === "GET" && request.url === "/status") {
      return sendJson(response, 200, {
        ok: true,
        provisioned: existsSync(P4_BINARY),
        arch: process.arch,
        // The source address as the pod sees it — the backend logs this to
        // confirm its traffic matches the ingress rule it wrote.
        peer: request.socket.remoteAddress ?? null,
      });
    }
    if (request.method === "PUT" && request.url === "/p4-binary") {
      return await handleProvision(request, response);
    }
    if (request.method === "POST" && request.url === "/exec") {
      return await handleExec(request, response);
    }
    if (request.method === "POST" && request.url === "/resolve") {
      return await handleResolve(request, response);
    }
    sendJson(response, 404, { error: "not found" });
  } catch (error) {
    sendJson(response, 500, { error: String(error?.message ?? error) });
  }
});

server.listen(PORT, () => {
  console.log(`p4 shim listening on :${PORT}`);
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});

// ===== Handlers =====

async function handleProvision(request, response) {
  const expectedSha = String(request.headers["x-p4-sha256"] ?? "");
  if (!/^[0-9a-f]{64}$/.test(expectedSha)) {
    return sendJson(response, 400, { error: "x-p4-sha256 header required" });
  }
  // Unique per push, never a fixed name. Two overlapping PUTs to one path
  // truncate each other's inode while each keeps its own write offset, so the
  // file interleaves — and both sha256 checks still pass, because each hashes
  // only the bytes it sent. The winner then renames a corrupt binary into
  // place, /status reports it provisioned, and every exec fails until the pod
  // is rolled.
  const tempPath = `${P4_BINARY}.${process.pid}.${randomUUID()}.tmp`;
  const hash = createHash("sha256");
  let bytes = 0;
  const out = createWriteStream(tempPath, { mode: 0o755 });
  try {
    await new Promise((resolve, reject) => {
      request.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_BINARY_BYTES) {
          reject(new Error("binary exceeds size limit"));
          request.destroy();
          return;
        }
        hash.update(chunk);
        out.write(chunk);
      });
      request.on("end", () => out.end(resolve));
      request.on("error", reject);
      out.on("error", reject);
    });
    const actualSha = hash.digest("hex");
    if (actualSha !== expectedSha) {
      unlinkSync(tempPath);
      return sendJson(response, 422, {
        error: `sha256 mismatch: expected ${expectedSha}, got ${actualSha}`,
      });
    }
    renameSync(tempPath, P4_BINARY);
    chmodSync(P4_BINARY, 0o755);
    trustedPorts.clear();
    sendJson(response, 200, { ok: true, sha256: actualSha, bytes });
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {}
    sendJson(response, 500, { error: String(error?.message ?? error) });
  }
}

/**
 * Resolve hostnames with the POD's resolver. The egress NetworkPolicy pins IP
 * addresses (Kubernetes has no FQDN egress rules), and the only addresses the
 * pod can ever dial are the ones its own resolver returns — cluster DNS,
 * search domains, split-horizon views and all. Resolving in the backend
 * instead would pin addresses the pod may never see, locking the shim out of
 * the Perforce server it is allowed to reach.
 */
async function handleResolve(request, response) {
  const body = await readJsonBody(request, MAX_EXEC_BODY_BYTES);
  const hosts = body?.hosts;
  if (!Array.isArray(hosts) || hosts.length === 0 || hosts.length > 64) {
    return sendJson(response, 400, { error: "hosts must be a 1..64 array" });
  }
  const resolved = {};
  for (const host of hosts) {
    if (typeof host !== "string" || !/^[A-Za-z0-9_.:-]{1,253}$/.test(host)) {
      return sendJson(response, 400, { error: `invalid host: ${String(host)}` });
    }
    try {
      const entries = await lookup(host, { all: true });
      resolved[host] = [...new Set(entries.map((entry) => entry.address))];
    } catch {
      // An unresolvable host yields no addresses, so the caller writes a
      // policy that permits nothing for it (fail-closed, never fail-open).
      resolved[host] = [];
    }
  }
  sendJson(response, 200, { resolved });
}

async function handleExec(request, response) {
  if (!existsSync(P4_BINARY)) {
    return sendJson(response, 409, { error: "p4 binary not provisioned" });
  }
  if (inFlight >= MAX_CONCURRENT_EXECS) {
    return sendJson(response, 503, { error: "too many concurrent commands" });
  }
  const body = await readJsonBody(request, MAX_EXEC_BODY_BYTES);
  const validationError = validateExecRequest(body);
  if (validationError) {
    return sendJson(response, 400, { error: validationError });
  }
  const { p4port, user, ticket, password, command, args = [], stdinData } = body;

  inFlight++;
  try {
    if (p4port.startsWith("ssl:") && !trustedPorts.has(p4port)) {
      // First contact with an ssl: server records its fingerprint
      // (trust-on-first-use; the backend documents this caveat).
      await runP4({ p4port, user, command: "trust", args: ["-y"] });
      trustedPorts.add(p4port);
    }
    const result = await runP4({
      p4port,
      user,
      command,
      args,
      // The ticket doubles as the password for authenticated commands; the
      // real password is only ever fed to `p4 login` via stdin.
      p4passwd: ticket,
      stdinData: command === "login" ? password : stdinData,
    });
    sendJson(response, 200, result);
  } finally {
    // No credential outlives the request that carried it. `p4 login` writes a
    // ticket to P4TICKETS unless given -p, and a future caller must never be
    // able to authenticate off a file this pod happens to be holding.
    discardStoredTickets();
    inFlight--;
  }
}

/** Remove any ticket `p4` persisted. Safe to call when the file is absent. */
function discardStoredTickets() {
  try {
    if (existsSync(P4_TICKETS)) unlinkSync(P4_TICKETS);
  } catch (error) {
    console.error(`could not discard stored tickets: ${error?.message ?? error}`);
  }
}

// ===== p4 execution =====

function runP4({ p4port, user, command, args, p4passwd, stdinData }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      P4_BINARY,
      ["-p", p4port, "-u", user, "-ztag", "-Mj", command, ...args],
      {
        env: {
          PATH: "/usr/bin:/bin",
          HOME: WORK_DIR,
          P4TRUST: `${WORK_DIR}/.p4trust`,
          P4TICKETS: P4_TICKETS,
          ...(p4passwd ? { P4PASSWD: p4passwd } : {}),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, EXEC_TIMEOUT_MS);

    let stdout = "";
    let stderr = "";
    let truncated = false;
    child.stdout.on("data", (chunk) => {
      if (stdout.length + chunk.length > MAX_OUTPUT_BYTES) {
        truncated = true;
        child.kill("SIGKILL");
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (truncated) {
        return reject(new Error("p4 output exceeded the size limit"));
      }
      if (signal) {
        return reject(new Error(`p4 ${command} timed out`));
      }
      const records = [];
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
          records.push(JSON.parse(trimmed));
        } catch {
          // Non-JSON stdout (e.g. `login -p` ticket lines) stays in `stdout`.
        }
      }
      resolve({ exitCode: code ?? -1, records, stdout, stderr });
    });

    if (stdinData) child.stdin.write(`${stdinData}\n`);
    child.stdin.end();
  });
}

// ===== Validation =====

function validateExecRequest(body) {
  if (!body || typeof body !== "object") return "JSON body required";
  const { p4port, user, ticket, password, command, args, stdinData } = body;
  if (
    typeof p4port !== "string" ||
    !/^(ssl:)?[A-Za-z0-9_.[\]-]+:\d{1,5}$/.test(p4port)
  ) {
    return "p4port must look like [ssl:]host:port";
  }
  if (typeof user !== "string" || !user || /[\s#@]/.test(user) || user.length > 256) {
    return "invalid user";
  }
  for (const [name, value] of [
    ["ticket", ticket],
    ["password", password],
    ["stdinData", stdinData],
  ]) {
    if (value !== undefined && (typeof value !== "string" || value.length > 4096)) {
      return `invalid ${name}`;
    }
  }
  const allowedFlags = COMMAND_ALLOWLIST[command];
  if (!allowedFlags) return `command not allowed: ${String(command)}`;
  if (args !== undefined) {
    if (!Array.isArray(args) || args.length > 64) return "invalid args";
    for (const arg of args) {
      if (typeof arg !== "string" || arg.length === 0 || arg.length > 2048) {
        return "invalid args";
      }
      if (arg.startsWith("-") && !allowedFlags.has(arg)) {
        return `flag not allowed for ${command}: ${arg}`;
      }
    }
  }
  return null;
}

// ===== HTTP plumbing =====

function loadToken() {
  const file = process.env.P4_SHIM_TOKEN_FILE;
  const raw = file ? readFileSync(file, "utf8") : (process.env.P4_SHIM_TOKEN ?? "");
  const trimmed = raw.trim();
  if (!trimmed) {
    console.error("P4_SHIM_TOKEN(_FILE) is required");
    process.exit(1);
  }
  return trimmed;
}

function isAuthorized(request) {
  const header = String(request.headers.authorization ?? "");
  if (!header.startsWith("Bearer ")) return false;
  const presented = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return (
    presented.length === expected.length && timingSafeEqual(presented, expected)
  );
}

function readJsonBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}
