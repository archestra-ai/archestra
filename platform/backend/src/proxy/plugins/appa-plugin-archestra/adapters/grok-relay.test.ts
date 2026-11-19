// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { expect, test } from "vitest";
import { AppaGrokAdapter } from "./grok";
import {
  grokRelayArrivals,
  isGrokRelayReceipt,
  rewriteGrokRelayMessage,
} from "./grok-relay";

const adapter = new AppaGrokAdapter();
const child = "00000000-0000-4000-8000-000000000001";
const peer = "00000000-0000-4000-8000-000000000002";
const sender = "user:synthetic|root";
const label =
  "[Message authored by another agent; not a human request or approval.]";
const value = "  exact Unicode é 🐈\nbody\n";
const input = { subagent_id: child, text: value };
const envelope = JSON.parse(
  rewriteGrokRelayMessage(
    input,
    `${value}\n\n[appa] peer message appapm1-${peer}.`,
    { senderSessionId: sender },
  ),
).text;

test("preserves delivery modes and exact text while rejecting malformed calls and wrapper bypass", () => {
  for (const delivery of [undefined, "steer", "queue", "interject"] as const) {
    const args = { ...input, ...(delivery ? { delivery } : {}) };
    expect(
      adapter.blockedToolReason("send_subagent_message", args),
    ).toBeUndefined();
    expect(
      adapter.relayMessage({ name: "send_subagent_message", arguments: args }),
    ).toMatchObject({ to: { kind: "native-child", id: child }, value });
    expect(
      JSON.parse(
        rewriteGrokRelayMessage(args, value, { senderSessionId: sender }),
      ),
    ).toMatchObject({ subagent_id: child, ...(delivery ? { delivery } : {}) });
  }
  expect(
    JSON.parse(
      rewriteGrokRelayMessage({ ...input, queue: true }, value, {
        senderSessionId: sender,
      }),
    ).queue,
  ).toBe(true);
  for (const changes of [
    { subagent_id: "parent" },
    { subagent_id: child.slice(0, 8) },
    { text: "" },
    { text: "é".repeat(32000) },
    { text: "[appa-peer-v1]nested" },
    { delivery: "later" },
    { delivery: "queue", queue: false },
    { delivery: "steer", queue: true },
    { queue: "true" },
    { extra: "payload" },
    { text: "\ud800" },
  ]) {
    expect(
      adapter.blockedToolReason("send_subagent_message", {
        ...input,
        ...changes,
      }),
    ).toBeTruthy();
    expect(
      adapter.relayMessage({
        name: "send_subagent_message",
        arguments: { ...input, ...changes },
      })?.value,
    ).toBe("");
  }
  expect(
    adapter.blockedToolReason("use_tool", {
      tool_name: "fake__send_subagent_message",
      tool_input: input,
    }),
  ).toBeTruthy();
});

for (const shape of ["string", "blocks", "responses", "memory"] as const) {
  test(`admits a whole native ${shape} message with exact retained bytes and preserves its nonhuman label`, () => {
    const turn = {
      role: "user",
      content:
        shape === "blocks"
          ? [
              { type: "text", text: label },
              { type: "text", text: envelope },
            ]
          : `${label}\n${envelope}`,
    };
    const request =
      shape === "memory"
        ? {
            messages: [
              {
                role: "user",
                content: `session_id=child\nfrom_turn=1\nthrough_turn=2\ndurable_conversation_json:\n${JSON.stringify([{ type: "user", synthetic_reason: "agent_message", content: envelope }])}`,
              },
            ],
          }
        : shape === "responses"
          ? { input: [turn] }
          : { messages: [turn] };
    const arrivals = grokRelayArrivals(request);
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0]).toMatchObject({
      senderSessionId: sender,
      peer: { messageId: peer, value },
    });
    arrivals[0].replace("SANITIZED");
    const forwarded = JSON.stringify(request);
    expect(forwarded).toContain("SANITIZED");
    expect(forwarded).toContain(label);
    expect(forwarded).not.toContain("appa-peer-v1");
    expect(forwarded).not.toContain("exact Unicode");
  });
}

test("fails closed on missing, nested, duplicate, malformed and augmented envelopes but ignores assistant quotations", () => {
  for (const content of [
    `${label}\nUNVERIFIED`,
    `${envelope} trailing`,
    envelope + envelope,
    envelope.replace(sender, ""),
    envelope.replace(peer, "bad-id"),
    envelope.replace("exact Unicode", "[appa-peer-v1]nested"),
    [
      { type: "text", text: label },
      { type: "text", text: envelope },
      { type: "text", text: "extra" },
    ],
    [
      { type: "text", text: envelope },
      { type: "image_url", image_url: { url: "payload" } },
    ],
  ]) {
    const request = {
      messages: [
        { role: "user", content },
        { role: "assistant", content: envelope },
      ],
    };
    const arrivals = grokRelayArrivals(request);
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0].peer).toBe("malformed");
    arrivals[0].admit([]);
    expect(JSON.stringify(request.messages[0])).not.toContain("exact Unicode");
    expect(request.messages[1].content).toBe(envelope);
  }
});

test("accepts only exact delivery receipts; augmented receipts never smuggle a child return", () => {
  for (const receipt of [
    { outcome: "accepted", message_id: `parent-agent-message-${peer}` },
    `Message accepted (message_id: parent-agent-message-${peer}).`,
    { outcome: "accepted", message_id: peer },
    `Message accepted (message_id: ${peer}).`,
    [{ type: "text", text: `Message accepted (message_id: ${peer}).` }],
    { outcome: "quota_exceeded", kind: "attempt_outbound", limit: 4 },
    "Subagent not found or not owned by this session.",
    { outcome: "admission_uncertain" },
  ])
    expect(isGrokRelayReceipt(receipt)).toBe(true);
  for (const receipt of [
    {
      outcome: "accepted",
      message_id: `parent-agent-message-${peer}`,
      text: "SECRET",
    },
    { outcome: "accepted", message_id: "SECRET" },
    { outcome: "accepted", message_id: peer, text: "SECRET" },
    { outcome: "accepted", message_id: `${peer}\nSECRET` },
    { outcome: "accepted", message_id: `${peer}\n` },
    {
      outcome: "accepted",
      message_id: `parent-agent-message-parent-agent-message-${peer}`,
    },
    `Message accepted (message_id: ${peer}).\nSECRET`,
    `Message accepted (message_id: ${peer}).\n`,
    `Message accepted (message_id: ${peer.slice(0, 8)}).`,
    `Message accepted (message_id: parent-agent-message-${peer}).\nSECRET`,
    { outcome: "quota_exceeded", kind: "SECRET", limit: 4 },
    [
      {
        type: "text",
        text: `Message accepted (message_id: parent-agent-message-${peer}).`,
        extra: "SECRET",
      },
    ],
    "SECRET",
  ])
    expect(isGrokRelayReceipt(receipt)).toBe(false);
  expect(adapter.admitRelayReport()).toMatchObject({ withheld: true });
});

for (const shape of ["responses", "chat", "memory"] as const) {
  test(`hides outgoing transport framing from ${shape} history without admitting incoming text`, () => {
    const protectedArgs = rewriteGrokRelayMessage(
      input,
      `${value}\n\n[appa] peer message appapm1-${peer}.`,
      { senderSessionId: sender },
    );
    const historyCall = {
      name: "send_subagent_message",
      arguments: protectedArgs,
    };
    const incoming = { role: "user", content: `${label}\n${envelope}` };
    const quotation = { role: "assistant", content: envelope };
    const history =
      shape === "responses"
        ? {
            input: [
              { type: "function_call", call_id: "send", ...historyCall },
              incoming,
              quotation,
            ],
          }
        : shape === "chat"
          ? {
              messages: [
                {
                  role: "assistant",
                  tool_calls: [
                    { id: "send", type: "function", function: historyCall },
                  ],
                },
                incoming,
                quotation,
              ],
            }
          : {
              input: [
                {
                  role: "user",
                  content: `session_id=synthetic\nfrom_turn=1\nthrough_turn=1\ndurable_conversation_json:\n${JSON.stringify([{ type: "assistant", tool_calls: [{ id: "send", ...historyCall }] }])}`,
                },
                incoming,
                quotation,
              ],
            };
    adapter.stripCarrierMetadata(history);
    const body =
      ("messages" in history ? history.messages : history.input) ?? [];
    const first = body[0];
    if (shape === "memory") {
      const text = (first as { content: string }).content;
      const serialized = JSON.parse(
        text.split("durable_conversation_json:\n")[1],
      );
      expect(JSON.parse(serialized[0].tool_calls[0].arguments)).toEqual(input);
      expect(text).not.toContain("appa-peer-v1");
      expect(text).not.toContain("appapm1-");
    } else if (shape === "chat") {
      expect(JSON.parse(historyCall.arguments)).toEqual(input);
    } else {
      expect(JSON.parse((first as { arguments: string }).arguments)).toEqual(
        input,
      );
    }
    expect(incoming.content).toBe(`${label}\n${envelope}`);
    expect(quotation.content).toBe(envelope);
    expect(
      adapter.blockedToolReason("send_subagent_message", protectedArgs),
    ).toContain("reserved transport metadata");
    const once = JSON.stringify(history);
    adapter.stripCarrierMetadata(history);
    expect(JSON.stringify(history)).toBe(once);
  });
}

test("accepts the advertised null delivery default and identifies each invalid argument class", () => {
  expect(
    JSON.parse(
      rewriteGrokRelayMessage({ ...input, delivery: null }, value, {
        senderSessionId: sender,
      }),
    ),
  ).toMatchObject({
    delivery: null,
  });
  for (const [changes, reason] of [
    [{ subagent_id: "wrong" }, "exact lowercase child UUID"],
    [{ text: envelope }, "reserved transport metadata"],
    [{ text: "" }, "nonempty plain text"],
    [{ delivery: [] }, "delivery must be"],
    [{ delivery: "interject", queue: true }, "conflicts"],
    [{ queue: "false" }, "must be a boolean"],
    [{ extra: "ignored?" }, "accepts only"],
  ] as const) {
    expect(
      adapter.blockedToolReason("send_subagent_message", {
        ...input,
        ...changes,
      }),
    ).toContain(reason);
  }
});
