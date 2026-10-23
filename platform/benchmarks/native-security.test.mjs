import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  fixedRoutes,
  loopbackOrigin,
  selectFixedRoute,
} from "./native-measurement-proxy.mjs";
import {
  prepareChecksData,
  STATIC_CHECK_SOURCE,
} from "./sequential-project-workload.mjs";

const origin = loopbackOrigin("http://127.0.0.1:9000/");
const agent = "agent-12345678";

test("forwarding selects a prebuilt loopback route", () => {
  const routes = fixedRoutes(origin, agent);
  const url = selectFixedRoute(routes, "/v1/mcp/agent-12345678");
  assert.equal(url.href, "http://127.0.0.1:9000/v1/mcp/agent-12345678");
  for (const hostile of [
    "http://169.254.169.254/latest/meta-data",
    "http://user:secret@127.0.0.1:9000/v1/mcp/agent-12345678",
    "/v1/mcp/agent-12345678/../../admin",
    "/v1/mcp/other-agent",
    "https://127.0.0.1:9000/v1/mcp/agent-12345678",
    "/v1/mcp/agent-12345678?next=http://example.com",
    "/v1/mcp/agent-12345678#fragment",
  ]) {
    assert.throws(() => selectFixedRoute(routes, hostile), hostile);
  }
  assert.throws(() => loopbackOrigin("http://example.com/"));
});

test("static check source ignores hostile fixture data", async () => {
  const normal = [
    {
      name: "add",
      path: "src/add.mjs",
      cases: [{ args: [1, 2], expected: 3 }],
    },
  ];
  const hostile = [
    {
      name: "add",
      path: "src/add.mjs",
      cases: [
        {
          args: [
            String.fromCharCode(96, 36, 123) +
              "process.exit(1)" +
              String.fromCharCode(125, 96, 10, 0x2028, 0x2029) +
              "\"; <script>require('child_process')",
          ],
          expected: "ok",
        },
      ],
    },
  ];
  const normalData = prepareChecksData(normal, 1);
  const hostileData = prepareChecksData(hostile, 1);
  assert.equal(STATIC_CHECK_SOURCE.includes("process.exit"), false);
  assert.equal(hostileData.includes("process.exit"), true);
  assert.deepEqual(
    JSON.parse(hostileData).tasks[0].cases[0].args,
    hostile[0].cases[0].args,
  );
  const dir = await mkdtemp(join(tmpdir(), "sequential-static-"));
  try {
    await writeFile(
      join(dir, "add.mjs"),
      "export function add(left, right) { return left + right; }\n",
    );
    await writeFile(
      join(dir, "checks.spec.mjs"),
      STATIC_CHECK_SOURCE.replace(
        'path.startsWith("/workspace/src/")',
        "path.startsWith(new URL('.', import.meta.url).pathname)",
      ),
    );
    await writeFile(
      join(dir, "checks.json"),
      normalData.replaceAll("/workspace/src/", `${dir}/`),
    );
    await import(pathToFileURL(join(dir, "checks.spec.mjs")).href);
    const parsed = JSON.parse(await readFile(join(dir, "checks.json"), "utf8"));
    assert.deepEqual(parsed.tasks[0].cases[0], {
      args: [1, 2],
      expected: 3,
      throws: false,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
