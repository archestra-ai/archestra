import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/cache-manager");

import { cacheManager } from "@/cache-manager";
import {
  beginConnectionPromptSession,
  recognizeConnectionSetup,
} from "./connection-prompt-session";

const USER = "user-1";
const OTHER = "user-2";
const ORG = "org-1";
const CLIENT = "claude-code" as const;
const ORIGIN = "https://ai.example.com";
const PROMPT =
  "Read https://ai.example.com/connect.md?client=claude-code and connect Claude Code.";

describe("connection prompt session", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  test("binds the first native session whose user text contains the exact prompt", async () => {
    const set = vi.spyOn(cacheManager, "set");
    const begun = await beginConnectionPromptSession({
      userId: USER,
      organizationId: ORG,
      clientId: CLIENT,
      origin: ORIGIN,
    });
    expect(Object.keys(begun)).toEqual(["expiresAt"]);
    expect(JSON.stringify(set.mock.calls)).not.toContain("archestra_setup_");
    expect(JSON.stringify(set.mock.calls)).not.toContain("archestra_con_");
    expect(set.mock.calls[0]?.[1]).toMatchObject({
      userId: USER,
      organizationId: ORG,
      clientId: CLIENT,
      origin: ORIGIN,
    });

    const unmatched = {
      messages: [{ role: "user", content: "Read the docs and connect." }],
    };
    expect(
      await recognizeConnectionSetup({
        userId: USER,
        organizationId: ORG,
        sessionId: "native-early",
        clientId: CLIENT,
        requestBody: unmatched,
      }),
    ).toBe(false);

    const body = {
      messages: [
        { role: "user", content: "hello" },
        {
          role: "user",
          content: [{ type: "text", text: `Please ${PROMPT} now` }],
        },
      ],
    };
    const snapshot = structuredClone(body);
    expect(
      await recognizeConnectionSetup({
        userId: USER,
        organizationId: ORG,
        sessionId: "native-a",
        clientId: CLIENT,
        requestBody: body,
      }),
    ).toBe(true);
    expect(body).toEqual(snapshot);
    expect(
      await recognizeConnectionSetup({
        userId: USER,
        organizationId: ORG,
        sessionId: "native-a",
      }),
    ).toBe(true);
    expect(
      await recognizeConnectionSetup({
        userId: USER,
        organizationId: ORG,
        sessionId: "native-b",
        clientId: CLIENT,
        requestBody: { messages: [{ role: "user", content: PROMPT }] },
      }),
    ).toBe(false);
    expect(
      await recognizeConnectionSetup({
        userId: USER,
        organizationId: ORG,
        sessionId: "native-b",
      }),
    ).toBe(false);
  });

  test("does not bind or consume a window from non-user text", async () => {
    await beginConnectionPromptSession({
      userId: USER,
      organizationId: ORG,
      clientId: CLIENT,
      origin: ORIGIN,
    });
    const body = {
      system: PROMPT,
      messages: [
        { role: "assistant", content: PROMPT },
        { role: "tool", content: PROMPT },
        { role: "system", content: PROMPT },
        {
          role: "user",
          content: [
            { type: "tool_result", content: PROMPT },
            {
              type: "tool_result",
              content: [{ type: "text", text: PROMPT }],
            },
            { type: "text", text: "connect without the prompt" },
          ],
        },
      ],
      contents: [
        {
          role: "user",
          parts: [
            { text: PROMPT, functionResponse: { name: "read", response: {} } },
            { text: PROMPT, functionCall: { name: "read", args: {} } },
          ],
        },
        { role: "model", parts: [{ text: PROMPT }] },
      ],
      input: [
        { type: "function_call_output", output: PROMPT },
        { type: "message", role: "assistant", content: PROMPT },
      ],
    };
    const snapshot = structuredClone(body);
    expect(
      await recognizeConnectionSetup({
        userId: USER,
        organizationId: ORG,
        sessionId: "native-a",
        clientId: CLIENT,
        requestBody: body,
      }),
    ).toBe(false);
    expect(body).toEqual(snapshot);
    expect(
      await recognizeConnectionSetup({
        userId: USER,
        organizationId: ORG,
        sessionId: "native-a",
        clientId: CLIENT,
        requestBody: { messages: [{ role: "user", content: PROMPT }] },
      }),
    ).toBe(true);
  });

  test("ambiguous text without an explicit user role cannot bind", async () => {
    await beginConnectionPromptSession({
      userId: USER,
      organizationId: ORG,
      clientId: CLIENT,
      origin: ORIGIN,
    });
    const owner = {
      userId: USER,
      organizationId: ORG,
      sessionId: "native-a",
      clientId: CLIENT,
    };
    for (const requestBody of [
      { input: PROMPT },
      { input: [{ type: "input_text", text: PROMPT }] },
      { messages: [{ role: "user", tool_call_id: "call-1", content: PROMPT }] },
      {
        input: [{ role: "user", tool_call_id: "call-1", content: PROMPT }],
      },
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `<system-reminder>${PROMPT}</system-reminder>`,
              },
            ],
          },
        ],
      },
    ]) {
      expect(await recognizeConnectionSetup({ ...owner, requestBody })).toBe(
        false,
      );
    }
    expect(
      await recognizeConnectionSetup({
        ...owner,
        requestBody: { messages: [{ role: "user", content: PROMPT }] },
      }),
    ).toBe(true);
  });

  test("a prompt in older conversation history cannot claim a new window", async () => {
    const histories = [
      {
        messages: [
          { role: "user", content: PROMPT },
          { role: "user", content: "Continue unrelated work" },
        ],
      },
      {
        messages: [
          { role: "user", content: PROMPT },
          { role: "user", content: "Continue unrelated work" },
          { role: "tool", content: "Latest tool response" },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "<system-reminder>Tool status</system-reminder>",
              },
            ],
          },
        ],
      },
      {
        contents: [
          { role: "user", parts: [{ text: PROMPT }] },
          { role: "user", parts: [{ text: "New question" }] },
        ],
      },
      {
        input: [
          { type: "message", role: "user", content: PROMPT },
          { type: "message", role: "user", content: "New question" },
        ],
      },
    ];
    for (const [index, requestBody] of histories.entries()) {
      await beginConnectionPromptSession({
        userId: USER,
        organizationId: ORG,
        clientId: CLIENT,
        origin: ORIGIN,
      });
      const sessionId = `old-history-${index}`;
      expect(
        await recognizeConnectionSetup({
          userId: USER,
          organizationId: ORG,
          clientId: CLIENT,
          sessionId,
          requestBody,
        }),
      ).toBe(false);
      expect(
        await recognizeConnectionSetup({
          userId: USER,
          organizationId: ORG,
          clientId: CLIENT,
          sessionId,
          requestBody: { messages: [{ role: "user", content: PROMPT }] },
        }),
      ).toBe(true);
    }
  });

  test("binds when the copied prompt is followed only by tool results and synthetic system text", async () => {
    await beginConnectionPromptSession({
      userId: USER,
      organizationId: ORG,
      clientId: CLIENT,
      origin: ORIGIN,
    });
    const requestBody = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Client context" },
            { type: "text", text: PROMPT },
            { type: "text", text: "Client context continued" },
          ],
        },
        { role: "system", content: "Transient context" },
        { role: "assistant", content: [{ type: "tool_use", name: "Bash" }] },
        {
          role: "user",
          content: [{ type: "tool_result", content: PROMPT }],
        },
        { role: "system", content: [{ type: "text", text: "Tool status" }] },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "<system-reminder>Background command completed</system-reminder>",
            },
            {
              type: "text",
              text: "<system-reminder>Task notification</system-reminder>",
            },
          ],
        },
      ],
    };
    expect(
      await recognizeConnectionSetup({
        userId: USER,
        organizationId: ORG,
        clientId: CLIENT,
        sessionId: "native-after-local-tools",
        requestBody,
      }),
    ).toBe(true);
  });

  test("accepts the exact prompt from each supported user-text shape", async () => {
    const shapes = [
      { messages: [{ role: "user", content: PROMPT }] },
      {
        messages: [{ role: "user", content: [{ type: "text", text: PROMPT }] }],
      },
      {
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: PROMPT }],
          },
        ],
      },
      {
        contents: [{ role: "user", parts: [{ text: PROMPT }] }],
      },
    ];
    for (const [index, requestBody] of shapes.entries()) {
      await beginConnectionPromptSession({
        userId: USER,
        organizationId: ORG,
        clientId: CLIENT,
        origin: ORIGIN,
      });
      const snapshot = structuredClone(requestBody);
      expect(
        await recognizeConnectionSetup({
          userId: USER,
          organizationId: ORG,
          sessionId: `native-${index}`,
          clientId: CLIENT,
          requestBody,
        }),
      ).toBe(true);
      expect(requestBody).toEqual(snapshot);
    }
  });

  test("rejects the wrong user, organization, client, and session without consuming the window", async () => {
    await beginConnectionPromptSession({
      userId: USER,
      organizationId: ORG,
      clientId: CLIENT,
      origin: ORIGIN,
    });
    const requestBody = { messages: [{ role: "user", content: PROMPT }] };
    const owner = {
      userId: USER,
      organizationId: ORG,
      sessionId: "native-a",
      clientId: CLIENT,
      requestBody,
    };
    expect(await recognizeConnectionSetup({ ...owner, userId: OTHER })).toBe(
      false,
    );
    expect(
      await recognizeConnectionSetup({ ...owner, organizationId: "org-2" }),
    ).toBe(false);
    expect(
      await recognizeConnectionSetup({ ...owner, clientId: "codex" }),
    ).toBe(false);
    expect(
      await recognizeConnectionSetup({ ...owner, clientId: "cursor" }),
    ).toBe(false);
    expect(await recognizeConnectionSetup({ ...owner, sessionId: "" })).toBe(
      false,
    );
    expect(
      await recognizeConnectionSetup({
        userId: USER,
        organizationId: ORG,
        sessionId: "native-a",
        clientId: CLIENT,
      }),
    ).toBe(false);
    expect(
      await recognizeConnectionSetup({
        userId: USER,
        organizationId: ORG,
        sessionId: "native-a",
        requestBody,
      }),
    ).toBe(false);
    expect(await recognizeConnectionSetup(owner)).toBe(true);
    expect(
      await recognizeConnectionSetup({
        ...owner,
        sessionId: "native-a",
        clientId: "codex",
        requestBody: undefined,
      }),
    ).toBe(false);
  });

  test("an expired window is not recognized and is not consumed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T12:00:00.000Z"));
    await beginConnectionPromptSession({
      userId: USER,
      organizationId: ORG,
      clientId: CLIENT,
      origin: ORIGIN,
    });
    const owner = {
      userId: USER,
      organizationId: ORG,
      sessionId: "native-a",
      clientId: CLIENT,
      requestBody: { messages: [{ role: "user", content: PROMPT }] },
    };
    vi.setSystemTime(new Date("2026-09-29T12:10:00.000Z"));
    expect(await recognizeConnectionSetup(owner)).toBe(false);
    vi.setSystemTime(new Date("2026-09-29T12:09:59.000Z"));
    expect(await recognizeConnectionSetup(owner)).toBe(true);
    vi.setSystemTime(new Date("2026-09-29T12:10:00.000Z"));
    expect(
      await recognizeConnectionSetup({
        userId: USER,
        organizationId: ORG,
        sessionId: "native-a",
      }),
    ).toBe(false);
  });

  test("concurrent claims produce a single binding", async () => {
    await beginConnectionPromptSession({
      userId: USER,
      organizationId: ORG,
      clientId: CLIENT,
      origin: ORIGIN,
    });
    const claim = (sessionId: string) =>
      recognizeConnectionSetup({
        userId: USER,
        organizationId: ORG,
        sessionId,
        clientId: CLIENT,
        requestBody: { messages: [{ role: "user", content: PROMPT }] },
      });
    const results = await Promise.all([claim("native-a"), claim("native-b")]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const bound = await Promise.all([
      recognizeConnectionSetup({
        userId: USER,
        organizationId: ORG,
        sessionId: "native-a",
      }),
      recognizeConnectionSetup({
        userId: USER,
        organizationId: ORG,
        sessionId: "native-b",
      }),
    ]);
    expect(bound.filter(Boolean)).toHaveLength(1);
  });

  test("parallel calls in the same native session share the first binding", async () => {
    await beginConnectionPromptSession({
      userId: USER,
      organizationId: ORG,
      clientId: CLIENT,
      origin: ORIGIN,
    });
    const params = {
      userId: USER,
      organizationId: ORG,
      clientId: CLIENT,
      sessionId: "native-a",
      requestBody: { messages: [{ role: "user", content: PROMPT }] },
    };
    expect(
      await Promise.all([
        recognizeConnectionSetup(params),
        recognizeConnectionSetup(params),
      ]),
    ).toEqual([true, true]);
  });

  test("builds the prompt from the browser origin and client label", async () => {
    await beginConnectionPromptSession({
      userId: USER,
      organizationId: ORG,
      clientId: "codex",
      origin: "http://localhost:3000",
    });
    expect(
      await recognizeConnectionSetup({
        userId: USER,
        organizationId: ORG,
        sessionId: "native-a",
        clientId: "codex",
        requestBody: {
          input: [
            {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: "Read http://localhost:3000/connect.md?client=codex and connect Codex.",
                },
              ],
            },
          ],
        },
      }),
    ).toBe(true);
  });

  test("a Codex direct-mode probe does not consume the pending window", async () => {
    const prompt =
      "Read https://ai.example.com/connect.md?client=codex and connect Codex.";
    const probe = "Reply with exactly OK.";
    const inlineTools = [
      {
        type: "namespace",
        name: "mcp__gw",
        description: prompt,
        tools: [
          {
            type: "function",
            name: "get_weather",
            description: prompt,
            parameters: {
              type: "object",
              properties: { note: { description: prompt } },
            },
          },
          {
            type: "function",
            name: "archestra__get_remedy_plans",
            description: probe,
            parameters: { type: "object", properties: {} },
          },
        ],
      },
    ];
    await beginConnectionPromptSession({
      userId: USER,
      organizationId: ORG,
      clientId: "codex",
      origin: ORIGIN,
    });
    const owner = {
      userId: USER,
      organizationId: ORG,
      sessionId: "codex-direct",
      clientId: "codex" as const,
    };
    const probes = [
      probe,
      prompt,
      { input: probe, tools: inlineTools },
      { input: prompt, tools: inlineTools },
      { input: [{ type: "input_text", text: prompt }], tools: inlineTools },
      {
        input: [{ type: "message", content: prompt }],
        tools: inlineTools,
      },
      {
        tools: inlineTools,
        input: [
          { type: "additional_tools", tools: inlineTools },
          {
            type: "function_call_output",
            call_id: "call_probe",
            output: prompt,
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: probe }],
          },
        ],
      },
    ];
    for (const requestBody of probes) {
      const snapshot = structuredClone(requestBody);
      expect(await recognizeConnectionSetup({ ...owner, requestBody })).toBe(
        false,
      );
      expect(requestBody).toEqual(snapshot);
    }
    expect(
      await recognizeConnectionSetup({
        userId: USER,
        organizationId: ORG,
        sessionId: "codex-direct",
      }),
    ).toBe(false);

    const boundBody = {
      tools: inlineTools,
      input: [
        { type: "additional_tools", tools: inlineTools },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: prompt }],
        },
      ],
    };
    const boundSnapshot = structuredClone(boundBody);
    expect(
      await recognizeConnectionSetup({
        ...owner,
        sessionId: "codex-user",
        requestBody: boundBody,
      }),
    ).toBe(true);
    expect(boundBody).toEqual(boundSnapshot);
    expect(
      await recognizeConnectionSetup({
        userId: USER,
        organizationId: ORG,
        sessionId: "codex-user",
      }),
    ).toBe(true);
    expect(
      await recognizeConnectionSetup({
        ...owner,
        sessionId: "codex-other",
        requestBody: boundBody,
      }),
    ).toBe(false);
  });

  test("refuses an anonymous caller, a non-origin, and an unsupported client", async () => {
    await expect(
      beginConnectionPromptSession({
        userId: "",
        organizationId: ORG,
        clientId: CLIENT,
        origin: ORIGIN,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
    await expect(
      beginConnectionPromptSession({
        userId: USER,
        organizationId: ORG,
        clientId: CLIENT,
        origin: "https://ai.example.com/connect.md",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      beginConnectionPromptSession({
        userId: USER,
        organizationId: ORG,
        clientId: "cursor",
        origin: ORIGIN,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
