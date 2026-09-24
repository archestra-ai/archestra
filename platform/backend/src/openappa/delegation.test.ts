import { beforeEach, describe, expect, test } from "vitest";
import config from "@/config";
import {
  type AppaDelegationMarker,
  collectDelegationMarkers,
  isDelegationMarkerItem,
  isDelegationMarkerLine,
  mintDelegationMarker,
  stripDelegationMarkers,
  verifyDelegationMarker,
} from "./delegation";

const SECRET = "delegation-test-secret-0123456789abcdef";
const SPAWN = {
  organizationId: "org-1",
  callerId: "user:u1",
  parentId: "s1",
  spawnerNativeId: "s1",
};
const PROMPT = "Summarize the failing tests.";

beforeEach(() => {
  config.openappa.offerSigningSecret = SECRET;
});

describe("delegation markers", () => {
  test("a minted marker reads back from the child's opening message and verifies", () => {
    const marker = mint();
    expect(marker).toMatch(
      /^\[appa\] delegated trajectory appa-[0-9a-f]{40} — child of s1\.$/,
    );

    const [read] = collectDelegationMarkers({
      family: "anthropic:messages",
      body: { messages: [{ role: "user", content: `${PROMPT}\n\n${marker}` }] },
    });
    expect(read.token).toMatch(/^appa-[0-9a-f]{40}$/);
    expect(read.parentId).toBe("s1");
    expect(verify(read)).toBe(true);
  });

  test("binds a v2 marker to the original spawn call", () => {
    const marker = mintDelegationMarker({
      ...SPAWN,
      prompt: PROMPT,
      spawnCallId: "toolu_spawn_1",
    });
    expect(marker).toMatch(
      /^\[appa\] delegated trajectory appa2-[A-Za-z0-9_-]+\.[0-9a-f]{40} — child of s1\.$/,
    );
    const read = readBack(`${PROMPT}\n\n${marker}`);
    expect(read.spawnCallId).toBe("toolu_spawn_1");
    expect(verify(read)).toBe(true);
    expect(verify({ ...read, spawnCallId: "toolu_other" })).toBe(false);
  });

  test("never verifies for another organization, caller, spawner, lineage or prompt", () => {
    const read = readBack(`${PROMPT}\n\n${mint()}`);

    expect(verify(read, { organizationId: "org-2" })).toBe(false);
    expect(verify(read, { callerId: "user:u2" })).toBe(false);
    expect(verify(read, { callerId: undefined })).toBe(false);
    expect(verify(read, { spawnerNativeId: "s2" })).toBe(false);
    expect(verify({ ...read, parentId: "s1:a1" })).toBe(false);
    // Lifted onto another prompt, the same line names nothing.
    expect(verify(readBack(`Something else.\n\n${lineOf(read)}`))).toBe(false);
  });

  test("rejects a tampered tag or nonce, another secret, and no secret at all", () => {
    const read = readBack(`${PROMPT}\n\n${mint()}`);
    const flip = (at: number) =>
      `${read.token.slice(0, at)}${read.token[at] === "0" ? "1" : "0"}${read.token.slice(at + 1)}`;

    expect(verify({ ...read, token: flip(read.token.length - 1) })).toBe(false);
    expect(verify({ ...read, token: flip("appa-".length) })).toBe(false);

    config.openappa.offerSigningSecret = `${SECRET}-rotated`;
    expect(verify(read)).toBe(false);

    config.openappa.offerSigningSecret = "";
    expect(verify(read)).toBe(false);
    expect(mintDelegationMarker({ ...SPAWN, prompt: PROMPT })).toBeUndefined();
  });

  test("tolerates a client that trims the prompt it passes on", () => {
    const marker = mintDelegationMarker({
      ...SPAWN,
      prompt: `  ${PROMPT}\n`,
    });
    expect(verify(readBack(`${PROMPT}\n\n${marker}`))).toBe(true);
  });

  test("a marker pushed as an item of its own verifies alone or joined to the text before it", () => {
    const marker = mintDelegationMarker({ ...SPAWN, prompt: "" });
    expect(verify(readBack(marker ?? ""))).toBe(true);
    expect(verify(readBack(`${PROMPT}\n${marker}`))).toBe(true);
  });

  test("a CRLF-formatted marker line reads back, verifies, and is recognized", () => {
    const marker = mint();
    const read = readBack(`${PROMPT}\r\n\r\n${marker}\r\n`);
    expect(read.parentId).toBe("s1");
    expect(verify(read)).toBe(true);
    expect(isDelegationMarkerLine(`${marker}\r`)).toBe(true);
    expect(isDelegationMarkerItem({ type: "text", text: `${marker}\r` })).toBe(
      true,
    );
  });

  test("reads parent ids with colons and dots back whole", () => {
    const parentId = "sess.1:agent.2:grand:3";
    const marker = mintDelegationMarker({ ...SPAWN, parentId, prompt: PROMPT });
    const read = readBack(`${PROMPT}\n\n${marker}`);
    expect(read.parentId).toBe(parentId);
    expect(verify(read)).toBe(true);
    expect(isDelegationMarkerLine(marker ?? "")).toBe(true);
    expect(isDelegationMarkerLine(`${marker}\nmore`)).toBe(false);
    expect(isDelegationMarkerItem({ type: "text", text: marker })).toBe(true);
    expect(
      isDelegationMarkerItem({ type: "text", text: marker, extra: 1 }),
    ).toBe(false);
  });
});

describe("collecting delegation markers", () => {
  test("Anthropic: user text and text blocks count; tool results, their turns and assistant text do not", () => {
    const [first, second, third, fourth] = ["a", "b", "c", "d"].map((id) =>
      mintDelegationMarker({ ...SPAWN, parentId: id, prompt: PROMPT }),
    );
    const markers = collectDelegationMarkers({
      family: "anthropic:messages",
      body: {
        messages: [
          { role: "user", content: `${PROMPT}\n\n${first}` },
          { role: "assistant", content: [{ type: "text", text: second }] },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                content: `${PROMPT}\n\n${third}`,
              },
              // A reminder the client attached beside the result.
              { type: "text", text: `${PROMPT}\n\n${third}` },
            ],
          },
          {
            role: "user",
            content: [{ type: "text", text: `${PROMPT}\n\n${fourth}` }],
          },
        ],
      },
    });
    expect(markers.map((marker) => marker.parentId)).toEqual(["a", "d"]);
  });

  test("Chat Completions: user content and text parts count; system, developer and tool messages do not", () => {
    const [first, second, third, fourth] = ["a", "b", "c", "d"].map((id) =>
      mintDelegationMarker({ ...SPAWN, parentId: id, prompt: PROMPT }),
    );
    const markers = collectDelegationMarkers({
      family: "openai:chatCompletions",
      body: {
        messages: [
          { role: "system", content: `${PROMPT}\n\n${second}` },
          { role: "developer", content: `${PROMPT}\n\n${second}` },
          { role: "user", content: `${PROMPT}\n\n${first}` },
          {
            role: "tool",
            tool_call_id: "c1",
            content: `${PROMPT}\n\n${third}`,
          },
          {
            role: "user",
            content: [{ type: "text", text: `${PROMPT}\n\n${fourth}` }],
          },
        ],
      },
    });
    expect(markers.map((marker) => marker.parentId)).toEqual(["a", "d"]);
  });

  test("Responses: user input_text counts; developer text and call outputs do not", () => {
    const [first, second, third] = ["a", "b", "c"].map((id) =>
      mintDelegationMarker({ ...SPAWN, parentId: id, prompt: PROMPT }),
    );
    const markers = collectDelegationMarkers({
      family: "openai:responses",
      body: {
        input: [
          {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: `${PROMPT}\n\n${second}` }],
          },
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: PROMPT },
              { type: "input_text", text: first },
            ],
          },
          {
            type: "function_call_output",
            call_id: "c1",
            output: `${PROMPT}\n\n${third}`,
          },
          { role: "user", content: `${PROMPT}\n\n${third}` },
        ],
      },
    });
    expect(markers.map((marker) => marker.parentId)).toEqual(["a", "c"]);
  });

  test("only a line that ends its text counts", () => {
    const marker = mint();
    expect(
      collectDelegationMarkers({
        family: "anthropic:messages",
        body: {
          messages: [
            { role: "user", content: `${marker}\n\nand then more text` },
          ],
        },
      }),
    ).toEqual([]);
  });
});

describe("stripping delegation markers", () => {
  test.each([
    "anthropic:messages",
    "openai:chatCompletions",
    "openai:responses",
  ] as const)("OpenCode task prompts lose markers on %s", (family) => {
    const args = { prompt: `${PROMPT}\n\n${mint()}` };
    const call =
      family === "anthropic:messages"
        ? { type: "tool_use", name: "task", input: args }
        : {
            type: "function_call",
            name: "task",
            arguments: JSON.stringify(args),
          };
    const body =
      family === "openai:responses"
        ? { input: [call] }
        : {
            messages: [
              {
                role: "assistant",
                ...(family === "anthropic:messages"
                  ? { content: [call] }
                  : { tool_calls: [{ type: "function", function: call }] }),
              },
            ],
          };

    stripDelegationMarkers({ family, body });

    if ("input" in call) {
      expect(call.input).toEqual({ prompt: PROMPT });
    } else {
      expect(JSON.parse(call.arguments)).toEqual({ prompt: PROMPT });
    }
  });

  test("Anthropic: the spawn call and the child's opening text come back as written", () => {
    const marker = mint();
    const body = {
      messages: [
        { role: "user", content: `${PROMPT}\n\n${marker}` },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Agent",
              input: {
                description: "tests",
                prompt: `${PROMPT}\n\n${marker}`,
              },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: `${PROMPT}\n\n${marker}`,
            },
          ],
        },
      ],
    };

    stripDelegationMarkers({ family: "anthropic:messages", body });

    expect(body.messages[0].content).toBe(PROMPT);
    expect(body.messages[1].content[0]).toMatchObject({
      input: { description: "tests", prompt: PROMPT },
    });
    // Tool-result content is model-visible, so its transport marker is hidden.
    expect(body.messages[2].content[0]).toMatchObject({
      content: PROMPT,
    });
  });

  test("strips markers from model-visible system and result text", () => {
    const marker = mint();
    const anthropic = {
      system: `${PROMPT}\n\n${marker}`,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Bash",
              input: { note: `${PROMPT}\n\n${marker}` },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: `${PROMPT}\n\n${marker}`,
            },
          ],
        },
      ],
    };

    stripDelegationMarkers({ family: "anthropic:messages", body: anthropic });

    expect(anthropic.system).toBe(PROMPT);
    expect(anthropic.messages[0].content[0]).toMatchObject({
      input: { note: `${PROMPT}\n\n${marker}` },
    });
    expect(anthropic.messages[1].content[0]).toMatchObject({
      content: PROMPT,
    });

    const responses = {
      instructions: `${PROMPT}\n\n${marker}`,
      input: [
        {
          type: "function_call",
          call_id: "c1",
          name: "exec",
          arguments: `{ "note": ${JSON.stringify(`${PROMPT}\n\n${marker}`)} }`,
        },
        {
          type: "function_call_output",
          call_id: "c1",
          output: `${PROMPT}\n\n${marker}`,
        },
      ],
    };

    stripDelegationMarkers({ family: "openai:responses", body: responses });

    expect(responses.instructions).toBe(PROMPT);
    expect(responses.input[0].arguments).toBe(
      `{ "note": ${JSON.stringify(`${PROMPT}\n\n${marker}`)} }`,
    );
    expect(responses.input[1].output).toBe(PROMPT);
  });

  test("Chat and Responses: JSON arguments lose the marker, item lists lose the marker item", () => {
    const marker = mint();
    const chat = {
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: {
                name: "task",
                arguments: JSON.stringify({
                  description: "d",
                  prompt: `${PROMPT}\n\n${marker}`,
                }),
              },
            },
          ],
        },
      ],
    };
    stripDelegationMarkers({ family: "openai:chatCompletions", body: chat });
    expect(
      JSON.parse(chat.messages[0].tool_calls[0].function.arguments),
    ).toEqual({ description: "d", prompt: PROMPT });

    const items = [{ type: "text", text: PROMPT }];
    const responses = {
      input: [
        {
          type: "function_call",
          call_id: "c2",
          name: "spawn_agent",
          namespace: "multi_agent_v1",
          arguments: JSON.stringify({
            items: [...items, { type: "text", text: marker }],
          }),
        },
        {
          type: "function_call",
          call_id: "c3",
          name: "spawn_agent",
          arguments: JSON.stringify({ message: `${PROMPT}\n\n${marker}` }),
        },
      ],
    };
    stripDelegationMarkers({ family: "openai:responses", body: responses });
    expect(JSON.parse(responses.input[0].arguments)).toEqual({ items });
    expect(responses.input[0].namespace).toBe("multi_agent_v1");
    expect(JSON.parse(responses.input[1].arguments)).toEqual({
      message: PROMPT,
    });
  });

  test.each([
    "functions.spawn_agent",
    "builtin:spawn_agent",
  ])("strips markers from normalized Codex spawn name %s", (name) => {
    const marker = mint();
    const body = {
      input: [
        {
          type: "function_call",
          call_id: "c1",
          name,
          arguments: JSON.stringify({
            message: `${PROMPT}\n\n${marker}`,
          }),
        },
      ],
    };

    stripDelegationMarkers({ family: "openai:responses", body });

    expect(JSON.parse(body.input[0].arguments)).toEqual({ message: PROMPT });
    expect(JSON.stringify(body)).not.toContain(marker);
  });

  test("never forwards a marker-only user turn on any supported family", () => {
    const marker = mint();
    const anthropic = {
      messages: [{ role: "user", content: [{ type: "text", text: marker }] }],
    };
    const chat = {
      messages: [{ role: "user", content: [{ type: "text", text: marker }] }],
    };
    const responses = {
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: marker }],
        },
      ],
    };
    const responsesString = { input: marker };

    stripDelegationMarkers({ family: "anthropic:messages", body: anthropic });
    stripDelegationMarkers({ family: "openai:chatCompletions", body: chat });
    stripDelegationMarkers({ family: "openai:responses", body: responses });
    stripDelegationMarkers({
      family: "openai:responses",
      body: responsesString,
    });

    for (const body of [anthropic, chat, responses, responsesString]) {
      expect(JSON.stringify(body)).not.toContain(marker);
    }
    expect(anthropic.messages[0].content[0].text.trim()).not.toBe("");
    expect(chat.messages[0].content[0].text.trim()).not.toBe("");
    expect(responses.input[0].content[0].text.trim()).not.toBe("");
    expect(responsesString.input.trim()).not.toBe("");
  });

  test("leaves marker-shaped non-spawn arguments byte-for-byte intact", () => {
    const marker = mint();
    const raw = `{ "note": ${JSON.stringify(`${PROMPT}\n\n${marker}`)} }`;
    const chat = {
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "Bash", arguments: raw },
            },
          ],
        },
      ],
    };

    stripDelegationMarkers({ family: "openai:chatCompletions", body: chat });

    expect(chat.messages[0].tool_calls[0].function.arguments).toBe(raw);
  });

  test("drops a part the marker filled alone without leaking a marker-only turn", () => {
    const marker = mint();
    const anthropic = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: PROMPT },
            { type: "text", text: marker },
          ],
        },
        { role: "user", content: marker },
      ],
    };
    stripDelegationMarkers({ family: "anthropic:messages", body: anthropic });
    expect(anthropic.messages[0].content).toEqual([
      { type: "text", text: PROMPT },
    ]);
    const markerOnlyContent = anthropic.messages[1].content;
    expect(typeof markerOnlyContent).toBe("string");
    if (typeof markerOnlyContent !== "string")
      throw new Error("expected string content");
    expect(markerOnlyContent).not.toContain(marker);
    expect(markerOnlyContent.trim()).not.toBe("");

    const chat = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: PROMPT },
            { type: "text", text: marker },
          ],
        },
      ],
    };
    stripDelegationMarkers({ family: "openai:chatCompletions", body: chat });
    expect(chat.messages[0].content).toEqual([{ type: "text", text: PROMPT }]);

    const responses = {
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: PROMPT },
            { type: "input_text", text: marker },
          ],
        },
      ],
    };
    stripDelegationMarkers({ family: "openai:responses", body: responses });
    expect(responses.input[0].content).toEqual([
      { type: "input_text", text: PROMPT },
    ]);
  });

  test("strips CRLF-formatted marker lines before provider dispatch", () => {
    const marker = mint();
    const body = {
      system: `${PROMPT}\r\n\r\n${marker}\r\n`,
      messages: [
        { role: "user", content: `${PROMPT}\r\n\r\n${marker}\r\n` },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Agent",
              input: { prompt: `${PROMPT}\r\n\r\n${marker}\r\n` },
            },
          ],
        },
      ],
    };

    stripDelegationMarkers({ family: "anthropic:messages", body });

    expect(JSON.stringify(body)).not.toContain(marker);
    expect(body.system).toBe(`${PROMPT}\n`);
    expect(body.messages[0].content).toBe(`${PROMPT}\n`);
    expect(body.messages[1].content[0]).toMatchObject({
      input: { prompt: `${PROMPT}\n` },
    });

    const responses = {
      input: [
        {
          type: "function_call",
          call_id: "c1",
          name: "spawn_agent",
          arguments: JSON.stringify({
            items: [
              { type: "text", text: PROMPT },
              { type: "text", text: `${marker}\r` },
            ],
          }),
        },
      ],
    };

    stripDelegationMarkers({ family: "openai:responses", body: responses });

    expect(JSON.parse(responses.input[0].arguments)).toEqual({
      items: [{ type: "text", text: PROMPT }],
    });
  });

  test("leaves a marker-like line with a malformed token, and is idempotent", () => {
    const lookalike = `${PROMPT}\n\n[appa] delegated trajectory appa-xyz — child of s1.`;
    const marker = mint();
    const body = {
      messages: [
        { role: "user", content: lookalike },
        { role: "user", content: `${PROMPT}\n\n${marker}` },
      ],
    };

    stripDelegationMarkers({ family: "anthropic:messages", body });
    const once = structuredClone(body);
    stripDelegationMarkers({ family: "anthropic:messages", body });

    expect(body.messages[0].content).toBe(lookalike);
    expect(body.messages[1].content).toBe(PROMPT);
    expect(body).toEqual(once);
  });
});

function mint(): string {
  const marker = mintDelegationMarker({ ...SPAWN, prompt: PROMPT });
  if (!marker) throw new Error("expected a marker");
  return marker;
}

function readBack(text: string): AppaDelegationMarker {
  const [marker] = collectDelegationMarkers({
    family: "anthropic:messages",
    body: { messages: [{ role: "user", content: text }] },
  });
  if (!marker) throw new Error("expected a marker in the text");
  return marker;
}

function lineOf(marker: AppaDelegationMarker): string {
  return `[appa] delegated trajectory ${marker.token} — child of ${marker.parentId}.`;
}

function verify(
  marker: AppaDelegationMarker,
  overrides: Partial<{
    organizationId: string;
    callerId: string | undefined;
    spawnerNativeId: string;
  }> = {},
): boolean {
  return verifyDelegationMarker({
    marker,
    organizationId: SPAWN.organizationId,
    callerId: SPAWN.callerId,
    spawnerNativeId: SPAWN.spawnerNativeId,
    ...overrides,
  });
}
