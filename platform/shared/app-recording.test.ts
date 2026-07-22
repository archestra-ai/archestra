import { describe, expect, it } from "vitest";
import {
  APP_RECORDING_REDACTED,
  APPS_HACKATHON_CLOSES_AT_MS,
  APPS_HACKATHON_OPENS_AT_MS,
  type AppRecordingBundle,
  isAppsHackathonOpen,
  normalizeCuts,
  pruneTrailingTrimEvents,
  redactSensitiveText,
  sanitizeRecordingBundle,
  validateRecordingBundle,
} from "./app-recording";

describe("isAppsHackathonOpen", () => {
  it("is closed before the window opens", () => {
    expect(isAppsHackathonOpen(APPS_HACKATHON_OPENS_AT_MS - 1)).toBe(false);
  });

  it("is open from the opening instant until the closing instant", () => {
    expect(isAppsHackathonOpen(APPS_HACKATHON_OPENS_AT_MS)).toBe(true);
    expect(isAppsHackathonOpen(APPS_HACKATHON_CLOSES_AT_MS - 1)).toBe(true);
  });

  it("is closed once the window closes", () => {
    // Half-open: the closing instant itself is already shut.
    expect(isAppsHackathonOpen(APPS_HACKATHON_CLOSES_AT_MS)).toBe(false);
  });

  it("spells the window as 22–29 July 2026, 00:00 UK (BST = UTC+1)", () => {
    expect(new Date(APPS_HACKATHON_OPENS_AT_MS).toISOString()).toBe(
      "2026-07-21T23:00:00.000Z",
    );
    expect(new Date(APPS_HACKATHON_CLOSES_AT_MS).toISOString()).toBe(
      "2026-07-28T23:00:00.000Z",
    );
  });
});

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

  it("accepts the submission facts — submitter identity, model, prompt count, final-cut duration", () => {
    const submission = bundle({
      meta: {
        authorName: "Tester",
        createdAt: "2026-01-01T00:01:00.000Z",
        platform: "archestra",
        github: { login: "octocat", name: "The Octocat" },
        model: "Claude Sonnet",
        userPromptCount: 3,
        finalCutDurationMs: 12_000,
      },
    });
    expect(validateRecordingBundle(submission).ok).toBe(true);
  });

  it("accepts a submitter with no public name set, but rejects an email riding along in meta.github", () => {
    const noPublicName = bundle({
      meta: {
        authorName: "Tester",
        createdAt: "2026-01-01T00:01:00.000Z",
        platform: "archestra",
        github: { login: "octocat", name: null },
      },
    });
    expect(validateRecordingBundle(noPublicName).ok).toBe(true);

    // The schema's own backstop: meta.github is .strict(), so even a client
    // bug that spread the whole GitHub /user response (email included)
    // instead of picking login/name is rejected here, not silently stored.
    const leakedEmail = bundle({
      meta: {
        authorName: "Tester",
        createdAt: "2026-01-01T00:01:00.000Z",
        platform: "archestra",
        github: {
          login: "octocat",
          name: "The Octocat",
          email: "octocat@example.com",
        },
      } as unknown as AppRecordingBundle["meta"],
    });
    expect(validateRecordingBundle(leakedEmail).ok).toBe(false);
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

  it("accepts captured audio events (config + chunk)", () => {
    const withAudio = bundle();
    withAudio.recording = {
      ...withAudio.recording,
      events: [
        ...withAudio.recording.events,
        {
          kind: "audio-config",
          t: 0,
          codec: "opus",
          sampleRate: 48_000,
          numberOfChannels: 2,
          description: "AQE4AQA=",
        },
        { kind: "audio-chunk", t: 100, tsUs: 100_000, data: "AAECAwQ=" },
      ],
    };
    expect(validateRecordingBundle(withAudio).ok).toBe(true);
  });

  it("rejects a malformed audio event", () => {
    const badAudio = bundle();
    badAudio.recording = {
      ...badAudio.recording,
      events: [
        ...badAudio.recording.events,
        // Missing the required sampleRate/numberOfChannels.
        { kind: "audio-config", t: 0, codec: "opus" } as never,
      ],
    };
    expect(validateRecordingBundle(badAudio).ok).toBe(false);
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

describe("normalizeCuts", () => {
  it("drops degenerate cuts, sorts, and merges overlaps into disjoint ranges", () => {
    expect(
      normalizeCuts([
        { fromMs: 3000, toMs: 4000 },
        { fromMs: 500, toMs: 500 }, // degenerate — dropped
        { fromMs: 1000, toMs: 2500 },
        { fromMs: 2000, toMs: 3500 }, // bridges the 1000–2500 and 3000–4000 runs
      ]),
    ).toEqual([{ fromMs: 1000, toMs: 4000 }]);
  });
});

describe("pruneTrailingTrimEvents", () => {
  const seg = { kind: "segment", t: 0, version: 1 } as const;

  function trimBundle(
    events: AppRecordingBundle["recording"]["events"],
    cuts?: { fromMs: number; toMs: number }[],
    durationMs = 5_000,
  ): AppRecordingBundle {
    return bundle({
      recording: {
        title: "demo",
        startedAt: "2026-01-01T00:00:00.000Z",
        durationMs,
        events,
        segments: [{ version: 1, html: "<h1>a</h1>", atMs: 0 }],
        transcript: [
          {
            id: "m1",
            role: "user",
            atMs: 0,
            parts: [{ type: "text", text: "hi" }],
          },
        ],
      },
      ...(cuts ? { edits: { cuts } } : {}),
    });
  }

  it("drops only non-viewport events inside a trailing trim, keeps the rest verbatim", () => {
    const before = {
      kind: "canvas",
      t: 1000,
      sel: "#c",
      data: "before",
    } as const;
    const view = {
      kind: "viewport",
      t: 3000,
      width: 800,
      height: 600,
    } as const;
    const b = trimBundle(
      [
        seg,
        before, // t <= fromMs — still plays
        view, // viewport — always kept (stage sizing)
        { kind: "canvas", t: 3500, sel: "#c", data: "inside" }, // dropped
        { kind: "dom", t: 4000, op: "html", sel: "#a", html: "x" }, // dropped
      ],
      [{ fromMs: 2000, toMs: 5000 }],
    );
    const out = pruneTrailingTrimEvents(b);
    expect(out.recording.events).toEqual([seg, before, view]);
    // Everything else is untouched.
    expect(out.edits).toEqual(b.edits);
    expect(out.recording.durationMs).toBe(b.recording.durationMs);
    expect(out.recording.segments).toEqual(b.recording.segments);
    expect(out.recording.transcript).toEqual(b.recording.transcript);
  });

  it("keeps an event past the trim's end — its anchor still shapes the clock", () => {
    const b = trimBundle(
      [
        seg,
        { kind: "canvas", t: 3500, sel: "#c", data: "inside" }, // dropped
        { kind: "canvas", t: 4990, sel: "#c", data: "past-end" }, // t > toMs — kept
      ],
      [{ fromMs: 2000, toMs: 4980 }],
    );
    expect(pruneTrailingTrimEvents(b).recording.events.map((e) => e.t)).toEqual(
      [0, 4990],
    );
  });

  it("no-ops without cuts", () => {
    const b = trimBundle([
      seg,
      { kind: "canvas", t: 1000, sel: "#c", data: "x" },
    ]);
    expect(pruneTrailingTrimEvents(b)).toBe(b);
  });

  it("no-ops for a mid cut that does not reach the data end", () => {
    const b = trimBundle(
      [
        seg,
        { kind: "canvas", t: 1500, sel: "#c", data: "x" },
        { kind: "canvas", t: 4000, sel: "#c", data: "y" },
      ],
      [{ fromMs: 1000, toMs: 2000 }],
    );
    expect(pruneTrailingTrimEvents(b)).toBe(b);
  });

  it("keeps an mcp that straddles the trim — its start anchor sits in the kept region", () => {
    // t=5000 is past the trim start (4000), but the call STARTED at t-durationMs
    // = 1000, before it — so its second compression anchor is in the kept region
    // and the event must survive even though it never renders.
    const straddle = {
      kind: "mcp",
      t: 5_000,
      method: "tools/call",
      durationMs: 4_000,
    } as const;
    const b = trimBundle(
      [
        seg,
        straddle,
        { kind: "canvas", t: 4_500, sel: "#c", data: "inside" }, // dropped
      ],
      [{ fromMs: 4_000, toMs: 10_000 }],
      10_000,
    );
    const out = pruneTrailingTrimEvents(b);
    expect(out.recording.events).toContainEqual(straddle);
    expect(out.recording.events.map((e) => e.t)).toEqual([0, 5_000]);
  });

  it("bails out when dropping would pull the data end in before the trim boundary", () => {
    // A canvas past the recorded duration defines the data end; dropping it would
    // move the tail-trim boundary, so the prune declines entirely.
    const b = trimBundle(
      [
        seg,
        { kind: "canvas", t: 1000, sel: "#c", data: "x" },
        { kind: "canvas", t: 3000, sel: "#c", data: "past-duration" },
      ],
      [{ fromMs: 500, toMs: 3000 }],
      2_000, // durationMs < 3000
    );
    expect(pruneTrailingTrimEvents(b)).toBe(b);
  });
});
