import assert from "node:assert/strict";
import test from "node:test";
import {
  fixedRoutes,
  loopbackOrigin,
  selectFixedRoute,
} from "./native-measurement-proxy.mjs";
import { renderSequentialChecks } from "./sequential-project-workload.mjs";

const origin = loopbackOrigin("http://127.0.0.1:9000/");
const agent = "agent-12345678";

test("forwarding accepts only fixed loopback routes", () => {
  const routes = fixedRoutes(origin, agent);
  const url = selectFixedRoute(routes, "/v1/mcp/agent-12345678");
  assert.equal(url.href, "http://127.0.0.1:9000/v1/mcp/agent-12345678");
  for (const hostile of [
    "http://169.254.169.254/latest/meta-data",
    "http://user:secret@127.0.0.1:9000/v1/mcp/agent-12345678",
    "http://127.0.0.1:9000/v1/mcp/agent-12345678/../../admin",
    "/v1/mcp/other-agent",
    "https://127.0.0.1:9000/v1/mcp/agent-12345678",
    "/v1/mcp/agent-12345678?next=http://example.com",
    "/v1/mcp/agent-12345678#fragment",
    "http://127.0.0.1:9001/v1/mcp/agent-12345678",
  ]) {
    assert.throws(() => selectFixedRoute(routes, hostile), hostile);
  }
  assert.throws(() => loopbackOrigin("http://example.com/"));
  assert.throws(() => loopbackOrigin("http://user:pw@127.0.0.1:9000/"));
});

test("generated checks embed hostile fixture text as data", () => {
  const source = renderSequentialChecks(
    [{ name: "toMinor", path: "src/toMinor.mjs", cases: [[["1"], 1]] }],
    1,
  );
  assert.doesNotMatch(source, /`|\$\{|eval\(|new Function/);
  assert.match(source, /toMinor/);
  const hostile = {
    name: "safeName",
    path: "src/safeName.mjs",
    cases: [
      {
        args: [
          "`${process.exit(1)}`\n\u2028\u2029\"; <script>require('child_process')",
        ],
        expected: "ok",
      },
    ],
  };
  const generated = renderSequentialChecks([hostile], 1);
  assert.match(generated, /decode\("[A-Za-z0-9+/]+=*"\)/);
  assert.doesNotMatch(
    generated,
    /process\.exit|require\(|`|\$\{|\u2028|\u2029/,
  );
  const encoded = generated.match(/decode\("([A-Za-z0-9+/]+=*)"\)/g);
  assert.ok(encoded.length >= 2);
  const decoded = encoded.map((call) =>
    JSON.parse(Buffer.from(call.slice(8, -2), "base64").toString("utf8")),
  );
  assert.deepEqual(decoded[1], [
    "`${process.exit(1)}`\n\u2028\u2029\"; <script>require('child_process')",
  ]);
});
