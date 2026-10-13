const assert = require("node:assert/strict");
const test = require("node:test");
const { replayOpenappaPolicy, getOpenappaReplayEngineVersion, inspectOpenappaPolicyTests } = require("./index.cjs");

const content = `
[policy]
version = 2
[[policy.tool]]
name = "files__read"
delta = { trust = "suspicious" }
[[policy.tool]]
name = "mail__send"
delta = {}
requires = { trust = "trusted" }
`;

test("native replay returns versioned decisions and refuses live configuration without production initialization", async () => {
  const result = JSON.parse(await replayOpenappaPolicy(JSON.stringify({
    content,
    files: [
      { path: "tainted.appa", content: "mcp/files/read {}\nexpect allow\nmcp/mail/send {}\nexpect deny" },
      { path: "mismatch.appa", content: "mcp/mail/send {}\nexpect deny" },
    ],
  })));
  assert.equal(result.engineVersion, getOpenappaReplayEngineVersion());
  assert.equal(result.files[0].status, "passed");
  assert.deepEqual(result.files[0].steps.map((step) => step.actual), ["allow", "deny"]);
  assert.equal(result.files[1].status, "failed");
  assert.equal(result.files[1].steps[0].actual, "allow");
  const unavailable = JSON.parse(await replayOpenappaPolicy(JSON.stringify({
    content: `${content}\n[[policy.annotator]]\nname = "model"\nbuiltin = "claude-code"`,
    files: [{ path: "static.appa", content: "mcp/files/read {}\nexpect allow" }],
  })));
  assert.equal(unavailable.files[0].status, "cannot_run");
  assert.equal(unavailable.files[0].assertionCount, 1);
  assert.equal(unavailable.files[0].steps.length, 0);
  assert.ok(unavailable.files[0].error);
});

test("native replay rejects duplicate trajectory paths at the host boundary", async () => {
  await assert.rejects(replayOpenappaPolicy(JSON.stringify({
    content,
    files: [{ path: "same.appa", content: "" }, { path: "same.appa", content: "" }],
  })), /unique relative/);
});

test("native replay honors the policy's helper response cap over the host default", async (t) => {
  const priorLimit = process.env.APPA_ARCHESTRA_MAX_BODY_BYTES;
  process.env.APPA_ARCHESTRA_MAX_BODY_BYTES = String(70 * 1024 * 1024);
  t.after(() => {
    if (priorLimit === undefined) delete process.env.APPA_ARCHESTRA_MAX_BODY_BYTES;
    else process.env.APPA_ARCHESTRA_MAX_BODY_BYTES = priorLimit;
  });
  const url = "http://127.0.0.1:9/api/guardrails-policy/annotators/noop";
  const response = { version: 1, answer: { delta: {}, requires: { history: [], attention: [] }, emits: [] } };
  const responseBytes = Buffer.byteLength(JSON.stringify(response));
  const policy = `[policy]
version = 2
[[policy.annotator]]
name = "noop"
[[policy.tool]]
name = "files__read"
annotator = "noop"
[externals.annotators.noop]
url = "${url}"
`;
  for (const [limit, expected] of [[undefined, "passed"], [responseBytes, "passed"], [responseBytes - 1, "cannot_run"]]) {
    const capped = limit === undefined ? policy : `${policy}[externals]\nmax_body_bytes = ${limit}\n`;
    const result = JSON.parse(await replayOpenappaPolicy(JSON.stringify({
      content: capped,
      files: [{ path: "helper-cap.appa", content: "mcp/files/read {}\nexpect allow" }],
      noopAnnotator: { url, response },
    })));
    assert.equal(result.files[0].status, expected, `helper cap ${limit}: ${JSON.stringify(result.files[0])}`);
  }
});

test("native inspection reports ordered tools and distinguishes invalid and empty files without a policy", async () => {
  const response = JSON.parse(await inspectOpenappaPolicyTests(JSON.stringify({
    files: [
      { path: "scenario.appa", content: "mcp/files/read {}\nexpect allow\nmcp/mail/send {}\nexpect deny\nmcp/files/read {}\nexpect allow" },
      { path: "broken.appa", content: "mcp/files/read {}\nexpect allow\nmcp/mail/send {}\nexpect maybe" },
      { path: "empty.appa", content: "# no assertions" },
      { path: "other-host.appa", content: "host/shell/run {}\nexpect allow" },
    ],
  })));
  assert.deepEqual(response.files[0], { path: "scenario.appa", tools: ["mcp/files/read", "mcp/mail/send"], assertionCount: 3, error: null });
  assert.equal(response.files[1].assertionCount, null);
  assert.deepEqual(response.files[1].tools, []);
  assert.match(response.files[1].error, /broken.appa:4:/);
  assert.deepEqual(response.files[2], { path: "empty.appa", tools: [], assertionCount: 0, error: null });
  assert.deepEqual(response.files[3].tools, ["host/shell/run"]);
});
