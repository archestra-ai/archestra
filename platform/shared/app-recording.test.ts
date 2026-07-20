import { describe, expect, it } from "vitest";
import {
  APP_RECORDING_REDACTED,
  type AppRecordingBundle,
  redactSensitiveText,
  sanitizeRecordingBundle,
  validateRecordingBundle,
} from "./app-recording";

function bundle(over?: Partial<AppRecordingBundle>): AppRecordingBundle {
  return {
    formatVersion: 1,
    app: { id: "6a7a44dd-14b1-4f1a-9d5e-13c8f2a90b11", name: "Demo App" },
    recording: {
      title: "Demo App demo",
      startedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 5_000,
      events: [
        { kind: "segment", t: 0, version: 1 },
        {
          kind: "input",
          t: 1_000,
          selector: "#field",
          value: "api_key=sk-abcdefghijklmnop1234",
        },
        {
          kind: "mcp",
          t: 2_000,
          method: "tools/call",
          toolName: "list_prs",
          result: { token: "ghp_abcdefghijklmnopqrstu123" },
        },
      ],
      segments: [{ version: 1, html: "<h1>app</h1>", atMs: 0 }],
      transcript: [
        {
          id: "m1",
          role: "user",
          atMs: -1_000,
          parts: [
            { type: "text", text: "use Bearer abcdefghijklmnop123456 please" },
          ],
        },
      ],
    },
    meta: {
      authorName: "Tester",
      createdAt: "2026-01-01T00:01:00.000Z",
      platform: "archestra",
    },
    ...over,
  };
}

describe("redactSensitiveText", () => {
  it("redacts common credential shapes and keyed secrets, keeps prose", () => {
    expect(redactSensitiveText("key sk-abcdefghijklmnop1234 here")).toBe(
      `key ${APP_RECORDING_REDACTED} here`,
    );
    expect(redactSensitiveText("password=hunter2secret")).toBe(
      `password=${APP_RECORDING_REDACTED}`,
    );
    expect(redactSensitiveText("plain sentence about building an app")).toBe(
      "plain sentence about building an app",
    );
  });
});

describe("sanitizeRecordingBundle", () => {
  it("redacts data planes but never the app's own HTML", () => {
    const sanitized = sanitizeRecordingBundle(bundle());
    const input = sanitized.recording.events.find((e) => e.kind === "input");
    expect(input && "value" in input ? input.value : "").toContain(
      APP_RECORDING_REDACTED,
    );
    const mcp = sanitized.recording.events.find((e) => e.kind === "mcp");
    expect(JSON.stringify(mcp && "result" in mcp ? mcp.result : "")).toContain(
      APP_RECORDING_REDACTED,
    );
    const textPart = sanitized.recording.transcript[0].parts[0];
    expect(textPart.type === "text" ? textPart.text : "").toContain(
      APP_RECORDING_REDACTED,
    );
    expect(sanitized.recording.segments[0].html).toBe("<h1>app</h1>");
  });

  it("carries the whole enhancement through, redacting its prose", () => {
    const sanitized = sanitizeRecordingBundle(
      bundle({
        enhancement: {
          description: "A demo app.",
          prompt: "Build me a counter",
          response: "Built it — it calls the API with token=ghp_abcdefghij123",
          category: "Development",
        },
      }),
    );
    // The closing response and the category reach storage: dropping them here
    // made every fresh recording replay the player's stock fallback line.
    expect(sanitized.enhancement?.response).toContain(APP_RECORDING_REDACTED);
    expect(sanitized.enhancement?.response).toContain("Built it");
    expect(sanitized.enhancement?.category).toBe("Development");
  });
});

describe("validateRecordingBundle", () => {
  it("accepts a well-formed bundle", () => {
    const result = validateRecordingBundle(bundle());
    expect(result.ok).toBe(true);
  });

  it("accepts cuts addressing pre-recording history of any age", () => {
    // Cuts share the transcript's coordinate space: a viewer can trim the
    // replayed head of a conversation that is days old, so raw cut times are
    // unbounded like transcript atMs (a week back here).
    const edited = bundle({
      edits: { cuts: [{ fromMs: -604_800_000, toMs: 1_000 }] },
    });
    const result = validateRecordingBundle(edited);
    expect(result.ok).toBe(true);
  });

  it("accepts the gallery facts — category, MCP servers, and version count", () => {
    const gallery = bundle({
      enhancement: {
        description: "A demo app.",
        prompt: "Build it",
        response: "Here is what I built.",
        category: "Development",
      },
      meta: {
        authorName: "Tester",
        createdAt: "2026-01-01T00:01:00.000Z",
        platform: "archestra",
        mcpServers: ["github", "slack"],
        appVersionCount: 14,
      },
    });
    expect(validateRecordingBundle(gallery).ok).toBe(true);
  });

  it("accepts an enhancement with and without the closing response", () => {
    const withResponse = bundle({
      enhancement: {
        description: "A demo app.",
        prompt: "Build it",
        response: "Here is what I built for you.",
      },
    });
    expect(validateRecordingBundle(withResponse).ok).toBe(true);
    // Bundles saved before the response field existed keep validating.
    const legacy = bundle({
      enhancement: { description: "A demo app.", prompt: "Build it" },
    });
    expect(validateRecordingBundle(legacy).ok).toBe(true);
  });

  it("accepts chat edits — enhancement toggle, removals, and user-text overrides", () => {
    const edited = bundle({
      edits: {
        cuts: [],
        chat: {
          enhancementDisabled: true,
          removedMessageIds: ["m1"],
          editedMessages: [{ id: "m1", text: "sharper ask" }],
        },
      },
    });
    expect(validateRecordingBundle(edited).ok).toBe(true);
  });

  it("rejects unknown chat-edit keys", () => {
    const smuggled = bundle({
      edits: {
        cuts: [],
        chat: { payload: "alert(1)" } as never,
      },
    });
    expect(validateRecordingBundle(smuggled).ok).toBe(false);
  });

  it("rejects unknown keys — a bundle carries only the declared static data", () => {
    const smuggled = { ...bundle(), payload: "alert(1)" };
    const result = validateRecordingBundle(smuggled);
    expect(result.ok).toBe(false);
  });

  it("requires an app version — a demo must capture the app being created", () => {
    const noApp = bundle();
    noApp.recording = { ...noApp.recording, segments: [] };
    const result = validateRecordingBundle(noApp);
    expect(result).toEqual({
      ok: false,
      reason:
        "The recording contains no app version — a demo must capture the app being created.",
    });
  });

  it("requires chat activity", () => {
    const noChat = bundle();
    noChat.recording = { ...noChat.recording, transcript: [] };
    const result = validateRecordingBundle(noChat);
    expect(result).toEqual({
      ok: false,
      reason: "The recording contains no chat activity.",
    });
  });
});
