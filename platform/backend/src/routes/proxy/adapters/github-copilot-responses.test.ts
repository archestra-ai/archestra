import { describe, expect, test } from "@/test";
import { githubCopilotResponsesAdapterFactory } from "./github-copilot-responses";

/**
 * Copilot's real streaming shape, reduced to the part that matters: every
 * per-item event carries its own opaque `item_id`, none of them equal to the
 * item's `id`. Captured from a live subscription (gpt-5.3-codex).
 */
const COPILOT_STREAM = [
  {
    type: "response.created",
    response: { id: "resp_1", model: "gpt-5.3-codex" },
  },
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "reasoning", id: "REASON_ID", encrypted_content: "xxx" },
  },
  {
    type: "response.reasoning_summary_part.added",
    item_id: "ROTATING_A",
    summary_index: 0,
  },
  {
    type: "response.reasoning_summary_text.delta",
    item_id: "ROTATING_B",
    summary_index: 0,
    delta: "thinking",
  },
  {
    type: "response.reasoning_summary_part.done",
    item_id: "ROTATING_C",
    summary_index: 0,
  },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: { type: "reasoning", id: "REASON_ID" },
  },
  {
    type: "response.output_item.added",
    output_index: 1,
    item: { type: "message", id: "MSG_ID", role: "assistant", content: [] },
  },
  {
    type: "response.content_part.added",
    item_id: "ROTATING_D",
    content_index: 0,
  },
  {
    type: "response.output_text.delta",
    item_id: "ROTATING_E",
    content_index: 0,
    delta: "CODEXOK",
  },
  {
    type: "response.output_text.done",
    item_id: "ROTATING_F",
    content_index: 0,
    text: "CODEXOK",
  },
  {
    type: "response.output_item.done",
    output_index: 1,
    item: { type: "message", id: "MSG_ID", role: "assistant", content: [] },
  },
  {
    type: "response.completed",
    response: { id: "resp_1", model: "gpt-5.3-codex" },
  },
];

function fakeClient(chunks: unknown[]) {
  return {
    responses: {
      create: async () => ({
        [Symbol.asyncIterator]: async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        },
      }),
    },
  };
}

async function collect(chunks: unknown[]) {
  const stream = await githubCopilotResponsesAdapterFactory.executeStream(
    fakeClient(chunks),
    { model: "gpt-5.3-codex" } as never,
  );
  const out: Record<string, unknown>[] = [];
  for await (const chunk of stream) {
    out.push(chunk as unknown as Record<string, unknown>);
  }
  return out;
}

describe("GitHub Copilot Responses stream normalization", () => {
  // A consumer registers a part when the item opens, then looks it up by each
  // event's item_id. Copilot's rotating ids make every lookup miss, which is
  // what crashed the AI SDK ("missing text part", "summaryParts" of undefined).
  test("binds every per-item event to the id of the item it belongs to", async () => {
    const out = await collect(COPILOT_STREAM);

    const idsFor = (prefix: string) =>
      out
        .filter((c) => String(c.type).startsWith(prefix))
        .map((c) => c.item_id);

    expect(idsFor("response.reasoning_summary")).toEqual([
      "REASON_ID",
      "REASON_ID",
      "REASON_ID",
    ]);
    expect([
      ...idsFor("response.content_part"),
      ...idsFor("response.output_text"),
    ]).toEqual(["MSG_ID", "MSG_ID", "MSG_ID"]);
  });

  test("leaves the event sequence and payloads otherwise untouched", async () => {
    const out = await collect(COPILOT_STREAM);

    expect(out.map((c) => c.type)).toEqual(COPILOT_STREAM.map((c) => c.type));
    // The text still reads the same; only ids were rewritten.
    const delta = out.find((c) => c.type === "response.output_text.delta");
    expect(delta?.delta).toBe("CODEXOK");
  });

  // Copilot has also been seen to omit `id` on a reasoning item. Propagating
  // `undefined` would register the part under a key no lookup can hit, which is
  // the same failure by another route.
  test("mints an id when Copilot omits one, rather than propagating undefined", async () => {
    const out = await collect([
      {
        type: "response.output_item.added",
        item: { type: "reasoning", encrypted_content: "xxx" },
      },
      {
        type: "response.reasoning_summary_part.added",
        item_id: "ROTATING",
        summary_index: 0,
      },
    ]);

    const added = out[0].item as { id?: string };
    expect(added.id).toBeTruthy();
    expect(out[1].item_id).toBe(added.id);
  });
});
