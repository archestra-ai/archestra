import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import {
  createA2aFixtureServer,
  DEFAULT_API_KEY,
  DEFAULT_BEARER_TOKEN,
} from "./server.mjs";

async function withServer(options, run) {
  const server = createA2aFixtureServer(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run(baseUrl);
  } finally {
    server.close();
    await once(server, "close");
  }
}

async function rpc(baseUrl, method, params, headers = {}) {
  const response = await fetch(`${baseUrl}/a2a`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { response, body: await response.json() };
}

function userMessage(text) {
  return {
    messageId: "50000000-0000-4000-8000-000000000001",
    role: "ROLE_USER",
    parts: [{ text }],
  };
}

test("publishes a v1 Agent Card and returns deterministic message/task responses", async () => {
  await withServer({ authMode: "none" }, async (baseUrl) => {
    const cardResponse = await fetch(
      `${baseUrl}/.well-known/agent-card.json`,
    );
    const card = await cardResponse.json();
    assert.equal(cardResponse.status, 200);
    assert.deepEqual(card.supportedInterfaces, [
      {
        url: `${baseUrl}/a2a`,
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
      },
    ]);
    assert.equal(card.capabilities.streaming, true);

    const immediate = await rpc(baseUrl, "SendMessage", {
      message: userMessage("[fixture:immediate] hello"),
    });
    assert.equal(
      immediate.body.result.message.parts[0].text,
      "Fixture response: hello",
    );

    const created = await rpc(baseUrl, "SendMessage", {
      message: userMessage("[fixture:artifact] payload"),
    });
    const task = created.body.result.task;
    assert.equal(task.status.state, "TASK_STATE_COMPLETED");
    assert.deepEqual(task.artifacts[0].parts[1].data, {
      fixture: true,
      input: "payload",
    });

    const fetched = await rpc(baseUrl, "GetTask", { id: task.id });
    assert.deepEqual(fetched.body.result, task);
  });
});

test("keeps working tasks cancellable and exposes spec error codes", async () => {
  await withServer({}, async (baseUrl) => {
    const created = await rpc(baseUrl, "SendMessage", {
      message: userMessage("[fixture:working] wait"),
    });
    const taskId = created.body.result.task.id;

    const canceled = await rpc(baseUrl, "CancelTask", { id: taskId });
    assert.equal(canceled.body.result.status.state, "TASK_STATE_CANCELED");

    const canceledAgain = await rpc(baseUrl, "CancelTask", { id: taskId });
    assert.equal(canceledAgain.body.error.code, -32002);

    const missing = await rpc(baseUrl, "GetTask", { id: "missing" });
    assert.equal(missing.body.error.code, -32001);
  });
});

test("enforces bearer and API-key modes without recording credentials", async () => {
  for (const scenario of [
    {
      authMode: "bearer",
      invalidHeaders: { authorization: "Bearer wrong" },
      validHeaders: { authorization: `Bearer ${DEFAULT_BEARER_TOKEN}` },
    },
    {
      authMode: "api-key",
      invalidHeaders: { "x-api-key": "wrong" },
      validHeaders: { "x-api-key": DEFAULT_API_KEY },
    },
  ]) {
    await withServer({ authMode: scenario.authMode }, async (baseUrl) => {
      const rejected = await rpc(
        baseUrl,
        "SendMessage",
        { message: userMessage("denied") },
        scenario.invalidHeaders,
      );
      assert.equal(rejected.response.status, 401);

      const accepted = await rpc(
        baseUrl,
        "SendMessage",
        { message: userMessage("allowed") },
        scenario.validHeaders,
      );
      assert.equal(accepted.response.status, 200);
      assert.ok(accepted.body.result.task);

      const journal = await fetch(`${baseUrl}/journal`).then((response) =>
        response.json(),
      );
      assert.equal(journal.requests.length, 2);
      assert.equal(
        journal.requests[0].headers.authorization ??
          journal.requests[0].headers["x-api-key"],
        "[REDACTED]",
      );

      const reset = await fetch(`${baseUrl}/reset`, { method: "POST" });
      assert.equal(reset.status, 204);
      const emptyJournal = await fetch(`${baseUrl}/journal`).then((response) =>
        response.json(),
      );
      assert.deepEqual(emptyJournal, { requests: [] });
    });
  }
});

test("streams a task, artifact, and terminal status as SSE", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/a2a`, {
      method: "POST",
      headers: {
        "a2a-version": "1.0",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "SendStreamingMessage",
        params: { message: userMessage("stream me") },
      }),
    });
    const payload = await response.text();
    const events = payload
      .split("\n\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line.replace(/^data: /, "")));

    assert.match(response.headers.get("content-type"), /^text\/event-stream/);
    assert.equal(events.length, 3);
    assert.ok(events[0].result.task);
    assert.ok(events[1].result.artifactUpdate);
    assert.equal(
      events[2].result.statusUpdate.status.state,
      "TASK_STATE_COMPLETED",
    );
  });
});
