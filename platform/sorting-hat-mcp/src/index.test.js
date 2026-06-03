import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeToolCall,
  callTool,
  castPatronus,
  createQuidditchStream,
  createSortingHatStream,
  flooTravel,
  sortTool,
} from "./index.js";

test("sorts risky tools into slytherin", () => {
  assert.deepEqual(sortTool({ toolName: "delete_database" }), {
    house: "slytherin",
    confidence: 0.94,
  });
});

test("respects please_not_slytherin header", () => {
  assert.deepEqual(
    sortTool({
      toolName: "delete_database",
      headers: { please_not_slytherin: "please" },
    }),
    {
      house: "ravenclaw",
      confidence: 0.76,
    },
  );
});

test("streams a rhyming sorting monologue with final house", () => {
  const stream = createSortingHatStream({
    toolName: "read_docs",
    toolDescription: "Read public docs",
  });

  assert.equal(stream.length, 4);
  assert.equal(stream.at(-1).data.house, "hufflepuff");
  assert.equal(stream.at(-1).data.done, true);
});

test("casts a deterministic Patronus snapshot", () => {
  assert.deepEqual(castPatronus({ userId: "user-123", charm: "expecto_patronum" }), {
    form: "falcon",
    corporeal: true,
  });
});

test("blocks non-corporeal Patronus for slytherin tools", () => {
  assert.deepEqual(
    authorizeToolCall({
      userId: "user-6",
      charm: "expecto_patronum",
      toolName: "delete_database",
    }),
    {
      authorized: false,
      sorting: { house: "slytherin", confidence: 0.94 },
      patronus: { form: "lynx", corporeal: false },
      reason: "non_corporeal_patronus_cannot_authorize_slytherin_tool",
    },
  );
});

test("routes floo travel with green flame particle metadata", () => {
  const result = flooTravel({
    fromServer: "sorting-hat-mcp",
    toServer: "github",
    payload: { method: "tools/call" },
  });

  assert.equal(result.particles.length, 12);
  assert.equal(result.particles.every((particle) => particle.color === "green"), true);
});

test("creates 60fps snitch progress events", () => {
  const stream = createQuidditchStream({ toolCallId: "call-1", frames: 3 });

  assert.deepEqual(
    stream.map((event) => [event.event, event.data.fps, event.data.shape, event.data.done]),
    [
      ["quidditch.snitch", 60, "golden-snitch", false],
      ["quidditch.snitch", 60, "golden-snitch", false],
      ["quidditch.snitch", 60, "golden-snitch", true],
    ],
  );
});

test("exposes all four MCP tools through callTool", () => {
  assert.equal(callTool("sorting_hat.sort", { toolName: "read_docs" }).house, "hufflepuff");
  assert.equal(callTool("patronus.cast", { userId: "user-123", charm: "expecto_patronum" }).form, "falcon");
  assert.equal(callTool("floo.travel", { fromServer: "a", toServer: "b", payload: {} }).particles.length, 12);
  assert.equal(callTool("quidditch.stream", { toolCallId: "call-1", frames: 1 }).length, 1);
});
