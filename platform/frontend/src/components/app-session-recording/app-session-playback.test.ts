import {
  type AppRecordingBundle,
  pruneTrailingTrimEvents,
} from "@archestra/shared";
import { describe, expect, it } from "vitest";
import {
  backfilledEnhancement,
  buildPlayback,
  classifyCut,
  classifyTimelineGesture,
  consolidatedTranscript,
  dominantViewport,
  keptTimelineRanges,
  neutralizeAppScripts,
  planPaintFlush,
  presentedTranscript,
  replayRegionLayout,
  replayStageFit,
  revealSchedule,
  trimCutsToExportLimit,
  uncutRecording,
} from "./app-session-player";

type Recording = Parameters<typeof buildPlayback>[0];

/** A minimal playback recording; override just the fields a case exercises. */
function recording(over: Partial<Recording>): Recording {
  return {
    appName: "App",
    title: "demo",
    startedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 4_000,
    events: [{ kind: "segment", t: 0, version: 1 }],
    segments: [{ version: 1, html: "<h1>a</h1>", atMs: 0 }],
    transcript: [],
    ...over,
  } as Recording;
}

describe("buildPlayback", () => {
  it("lays the whole session on one timeline — history animates before the recording window", () => {
    const playback = buildPlayback(
      recording({
        transcript: [
          {
            id: "u1",
            role: "user",
            atMs: -10_000,
            parts: [{ type: "text", text: "build me an app" }],
          },
          {
            id: "a1",
            role: "assistant",
            atMs: -4_000,
            parts: [{ type: "text", text: "done" }],
          },
        ],
        events: [
          { kind: "segment", t: 0, version: 1 },
          { kind: "pointer", t: 500, type: "click", x: 1, y: 2 },
        ],
      }),
    );

    // Nothing opens already-sent: every message sits past the preroll beat.
    for (const message of playback.transcript) {
      expect(message.atMs).toBeGreaterThan(0);
    }
    // Pre-recording history plays before the recording's app events.
    const firstEventT = Math.min(...playback.events.map((event) => event.t));
    for (const message of playback.transcript) {
      expect(message.atMs).toBeLessThan(firstEventT);
    }
    // Order is preserved.
    expect(playback.transcript[0].atMs).toBeLessThan(
      playback.transcript[1].atMs,
    );
    // The timeline runs at least to the last app event.
    expect(playback.duration).toBeGreaterThanOrEqual(firstEventT);
  });

  it("time-lapses long idle gaps between messages", () => {
    const playback = buildPlayback(
      recording({
        durationMs: 1_000,
        transcript: [
          {
            id: "u1",
            role: "user",
            atMs: -3_600_000, // an hour before recording
            parts: [{ type: "text", text: "first" }],
          },
          {
            id: "u2",
            role: "user",
            atMs: -100,
            parts: [{ type: "text", text: "second" }],
          },
        ],
      }),
    );

    // An hour of dead air between the two turns collapses to a brief beat.
    const gap = playback.transcript[1].atMs - playback.transcript[0].atMs;
    expect(gap).toBeLessThanOrEqual(900);
  });

  it("collapses a cut range to zero time without dropping its events", () => {
    const base = {
      durationMs: 10_000,
      events: [
        { kind: "segment", t: 0, version: 1 },
        { kind: "pointer", t: 1_000, type: "click", x: 1, y: 1 },
        { kind: "pointer", t: 4_000, type: "click", x: 2, y: 2 },
        { kind: "pointer", t: 4_500, type: "click", x: 3, y: 3 },
        { kind: "pointer", t: 9_000, type: "click", x: 4, y: 4 },
      ] as Recording["events"],
    };
    const uncut = buildPlayback(recording(base));
    const cut = buildPlayback(
      recording({
        ...base,
        edits: { cuts: [{ fromMs: 3_000, toMs: 8_000 }] },
      }),
    );

    // The cut shortens playback but discards nothing.
    expect(cut.duration).toBeLessThan(uncut.duration);
    expect(cut.events).toHaveLength(uncut.events.length);

    // Events inside the cut land together at the cut point (applied instantly,
    // keeping app state in sync), and order is preserved throughout.
    const clicks = cut.events
      .filter(
        (event): event is Extract<typeof event, { kind: "pointer" }> =>
          event.kind === "pointer",
      )
      .sort((a, b) => a.t - b.t);
    expect(clicks[1].t).toBe(clicks[2].t);
    expect(clicks[0].t).toBeLessThan(clicks[1].t);
    expect(clicks[2].t).toBeLessThanOrEqual(clicks[3].t);
  });

  it("resolves a cut's collapse instant forward to the next kept moment", () => {
    const playback = buildPlayback(
      recording({
        durationMs: 10_000,
        events: [
          { kind: "segment", t: 0, version: 1 },
          { kind: "pointer", t: 9_000, type: "click", x: 1, y: 1 },
        ] as Recording["events"],
        edits: { cuts: [{ fromMs: 3_000, toMs: 8_000 }] },
      }),
    );

    // Both cut edges collapse to the same playback instant…
    const boundary = playback.toPlaybackMs(3_000);
    expect(playback.toPlaybackMs(8_000)).toBe(boundary);
    // …and that instant maps back to the start of the NEXT kept content, so
    // seeking to the first moment after a cut never displays the playhead at
    // the end of the section before it.
    expect(playback.toRawMs(boundary)).toBe(8_000);
  });

  it("resolves playback's end to the last kept moment, not the far edge of a tail trim", () => {
    const playback = buildPlayback(
      recording({
        durationMs: 10_000,
        events: [
          { kind: "segment", t: 0, version: 1 },
          { kind: "pointer", t: 9_000, type: "click", x: 1, y: 1 },
        ] as Recording["events"],
        edits: { cuts: [{ fromMs: 6_000, toMs: 10_000 }] },
      }),
    );

    expect(playback.toRawMs(playback.duration)).toBe(6_000);
  });

  it("drops chat messages inside a cut — nothing said during a removed stretch replays", () => {
    const playback = buildPlayback(
      recording({
        durationMs: 10_000,
        transcript: [
          {
            id: "keep-before",
            role: "user",
            atMs: 1_000,
            parts: [{ type: "text", text: "before the cut" }],
          },
          {
            id: "inside-cut",
            role: "assistant",
            atMs: 4_500,
            parts: [{ type: "text", text: "edited out" }],
          },
          {
            id: "keep-after",
            role: "user",
            atMs: 9_000,
            parts: [{ type: "text", text: "after the cut" }],
          },
        ] as Recording["transcript"],
        events: [
          { kind: "segment", t: 0, version: 1 },
          { kind: "pointer", t: 9_500, type: "click", x: 1, y: 1 },
        ] as Recording["events"],
        edits: { cuts: [{ fromMs: 3_000, toMs: 6_000 }] },
      }),
    );

    // The removed stretch's message is gone entirely — not replayed in a
    // burst at the cut's collapse point — while its neighbors stay in order.
    expect(playback.transcript.map((message) => message.id)).toEqual([
      "keep-before",
      "keep-after",
    ]);
    expect(playback.transcript[0].atMs).toBeLessThan(
      playback.transcript[1].atMs,
    );
  });

  it("cutting a slice of the opening lead-in removes exactly that slice", () => {
    const base = {
      durationMs: 6_000,
      transcript: [
        {
          id: "u1",
          role: "user",
          atMs: -2_000,
          parts: [{ type: "text", text: "hi" }],
        },
      ] as Recording["transcript"],
    };
    const uncut = buildPlayback(recording(base));
    // The raw axis extends a preroll's length below the oldest content, so
    // the synthetic lead-in is addressable by cuts like recorded content.
    const leadStart = Math.round(uncut.toRawMs(0));
    expect(leadStart).toBe(-2_000 - 1_200);
    expect(uncut.transcript[0].atMs).toBe(1_200);

    const sliced = buildPlayback(
      recording({
        ...base,
        edits: {
          cuts: [{ fromMs: leadStart + 200, toMs: leadStart + 900 }],
        },
      }),
    );
    // 700ms of the lead is gone — no more, no less.
    expect(uncut.transcript[0].atMs - sliced.transcript[0].atMs).toBe(700);

    // Cutting the whole lead opens the replay instantly.
    const tight = buildPlayback(
      recording({
        ...base,
        edits: { cuts: [{ fromMs: leadStart, toMs: -2_000 }] },
      }),
    );
    expect(tight.transcript[0].atMs).toBe(0);
  });

  it("a cut reaching the session's end trims the tail instead of collapsing it", () => {
    const base = {
      durationMs: 10_000,
      events: [
        { kind: "segment", t: 0, version: 1 },
        { kind: "pointer", t: 1_000, type: "click", x: 1, y: 1 },
        { kind: "pointer", t: 9_000, type: "click", x: 2, y: 2 },
      ] as Recording["events"],
      transcript: [
        {
          id: "u1",
          role: "user",
          atMs: -1_000,
          parts: [{ type: "text", text: "hi" }],
        },
        {
          id: "u2",
          role: "user",
          atMs: 9_500,
          parts: [{ type: "text", text: "late" }],
        },
      ] as Recording["transcript"],
    };
    const uncut = buildPlayback(recording(base));
    const trimmed = buildPlayback(
      recording({
        ...base,
        edits: { cuts: [{ fromMs: 5_000, toMs: 10_000 }] },
      }),
    );

    // Playback genuinely ends at the trim: nothing inside the trimmed tail
    // plays — its events and messages are left out, not applied at the end.
    expect(trimmed.duration).toBeLessThan(uncut.duration);
    expect(trimmed.duration).toBe(trimmed.toPlaybackMs(5_000));
    const pointers = trimmed.events.filter((event) => event.kind === "pointer");
    expect(pointers).toHaveLength(1);
    expect(pointers[0]).toMatchObject({ x: 1, y: 1 });
    expect(trimmed.transcript.map((message) => message.id)).toEqual(["u1"]);
  });

  it("maps playback time back to raw recording time for storing edits", () => {
    const playback = buildPlayback(
      recording({
        durationMs: 5_000,
        events: [
          { kind: "segment", t: 0, version: 1 },
          { kind: "pointer", t: 5_000, type: "click", x: 1, y: 1 },
        ],
      }),
    );
    // Raw anchors map back to themselves through the compression and its
    // inverse, and the mapping is monotonic between them.
    const events = [...playback.events].sort((a, b) => a.t - b.t);
    expect(playback.toRawMs(events[0].t)).toBe(0);
    expect(playback.toRawMs(events[1].t)).toBe(5_000);
    const mid = playback.toRawMs((events[0].t + events[1].t) / 2);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(5_000);
  });

  /** A two-version build: v1 is interacted with, then v2 replaces it. */
  const twoVersions = {
    durationMs: 6_000,
    segments: [
      { version: 1, html: "<h1>v1</h1>", atMs: 0 },
      { version: 2, html: "<h1>v2</h1>", atMs: 4_000 },
    ],
    events: [
      { kind: "viewport", t: 0, width: 1024, height: 768 },
      { kind: "segment", t: 0, version: 1 },
      { kind: "pointer", t: 1_000, type: "click", x: 1, y: 1 },
      { kind: "segment", t: 4_000, version: 2 },
      { kind: "pointer", t: 5_000, type: "click", x: 2, y: 2 },
    ],
  } as Partial<Recording>;
  const enhancement = { description: "An app.", prompt: "Build me an app" };

  it("replays only the last app version and its events once enhanced", () => {
    const playback = buildPlayback(recording({ ...twoVersions, enhancement }));

    // The enhanced chat claims one prompt built the app, so the stage must not
    // swap versions behind it.
    expect(playback.segments.map((segment) => segment.version)).toEqual([2]);
    // v1's click would land on markup v2 no longer has.
    expect(
      playback.events.filter((event) => event.kind === "pointer"),
    ).toHaveLength(1);
    // The stage still needs its size — viewport is setup, not interaction.
    expect(playback.events.some((event) => event.kind === "viewport")).toBe(
      true,
    );
  });

  it("keeps every version when the enhancement is off or switched off", () => {
    const plain = buildPlayback(recording(twoVersions));
    expect(plain.segments.map((segment) => segment.version)).toEqual([1, 2]);
    expect(
      plain.events.filter((event) => event.kind === "pointer"),
    ).toHaveLength(2);

    // The author can toggle the enhancement off; the real build comes back.
    const disabled = buildPlayback(
      recording({
        ...twoVersions,
        enhancement,
        edits: { cuts: [], chat: { enhancementDisabled: true } },
      }),
    );
    expect(disabled.segments.map((segment) => segment.version)).toEqual([1, 2]);
  });

  it("never compresses time across the app's own activity", () => {
    // The gap between two app events is the app RUNNING — a game moving, an
    // animation playing. Compressing it replays the app faster than it
    // happened, which is a false recording, not a time-lapse. This is the shape
    // of a game: sparse keypresses with seconds of play between them.
    const playback = buildPlayback(
      recording({
        durationMs: 12_000,
        events: [
          { kind: "segment", t: 0, version: 1 },
          {
            kind: "key",
            t: 1_000,
            type: "down",
            key: "ArrowUp",
            code: "ArrowUp",
          },
          {
            kind: "key",
            t: 5_000,
            type: "down",
            key: "ArrowLeft",
            code: "ArrowLeft",
          },
          {
            kind: "key",
            t: 11_000,
            type: "down",
            key: "ArrowDown",
            code: "ArrowDown",
          },
        ],
      }),
    );
    const keys = playback.events
      .filter((event) => event.kind === "key")
      .map((event) => event.t)
      .sort((a, b) => a - b);
    // The 4s and 6s of gameplay between the presses survive intact.
    expect(keys[1] - keys[0]).toBe(4_000);
    expect(keys[2] - keys[1]).toBe(6_000);
  });

  it("time-lapses a long build but not the short game played after it", () => {
    // The shape that matters: the recorder is conversation-scoped, so a session
    // is usually a long build (agent tool calls, minutes of waiting) followed by
    // a short stretch of actually using the app. The build compresses; the game
    // does not. Treating the build's tool calls as app activity replayed a
    // 19-second game as a 36-minute sit-through.
    const playback = buildPlayback(
      recording({
        durationMs: 620_000,
        events: [
          { kind: "segment", t: 0, version: 1 },
          {
            kind: "mcp",
            t: 120_000,
            method: "tools/call",
            toolName: "scaffold_app",
          },
          {
            kind: "mcp",
            t: 360_000,
            method: "tools/call",
            toolName: "edit_app",
          },
          { kind: "segment", t: 600_000, version: 2 },
          // The game: ten seconds of play at the very end.
          {
            kind: "key",
            t: 610_000,
            type: "down",
            key: "ArrowUp",
            code: "ArrowUp",
          },
          {
            kind: "key",
            t: 620_000,
            type: "down",
            key: "ArrowDown",
            code: "ArrowDown",
          },
        ],
      }),
    );
    const keys = playback.events
      .filter((event) => event.kind === "key")
      .map((event) => event.t)
      .sort((a, b) => a - b);
    // The ten seconds of gameplay survive intact...
    expect(keys[1] - keys[0]).toBe(10_000);
    // ...while the ten minutes of building ahead of it do not play out in real
    // time. The whole replay stays far shorter than the raw session.
    expect(playback.duration).toBeLessThan(60_000);
  });

  it("still time-lapses the chat waiting on itself", () => {
    // A long wait between two messages with nothing happening in the app is
    // dead air, and is exactly what the compression is for.
    const playback = buildPlayback(
      recording({
        durationMs: 1,
        events: [],
        transcript: [
          {
            id: "u1",
            role: "user",
            atMs: 0,
            parts: [{ type: "text", text: "build me an app" }],
          },
          {
            id: "a1",
            role: "assistant",
            atMs: 60_000,
            parts: [{ type: "text", text: "done" }],
          },
        ],
      }),
    );
    const [first, second] = playback.transcript.map((message) => message.atMs);
    expect(second - first).toBeLessThanOrEqual(1_000);
  });

  it("measures the uncut ruler against the same session that plays", () => {
    // The strip is built from the recording with its cuts dropped. Dropping the
    // whole edits object also drops the chat's enhancement toggle, which left
    // the ruler stuck at the enhanced length while playback ran the full chat.
    const off = recording({
      ...twoVersions,
      enhancement,
      edits: {
        cuts: [{ fromMs: 1_000, toMs: 2_000 }],
        chat: { enhancementDisabled: true },
      },
    });
    const uncut = uncutRecording(off);
    expect(uncut.edits?.cuts).toEqual([]);
    expect(uncut.edits?.chat?.enhancementDisabled).toBe(true);
    // The ruler therefore shows every version, exactly as playback does.
    expect(buildPlayback(uncut).segments.map((s) => s.version)).toEqual([1, 2]);

    // And the toggle genuinely changes what the ruler measures, or the above
    // proves nothing.
    const on = uncutRecording(
      recording({ ...twoVersions, enhancement, edits: { cuts: [] } }),
    );
    expect(buildPlayback(on).segments.map((s) => s.version)).toEqual([2]);
  });

  it("always leaves an app on the stage, even when a trim removes every version", () => {
    const playback = buildPlayback(
      recording({
        ...twoVersions,
        // An end trim reaching back past both versions.
        edits: { cuts: [{ fromMs: -5_000, toMs: 60_000 }] },
      }),
    );
    expect(playback.segments).toHaveLength(1);
  });
});

describe("classifyCut", () => {
  it("classifies edge-touching cuts as trims in raw time — the preroll offset must not matter", () => {
    const playback = buildPlayback(
      recording({
        durationMs: 10_000,
        transcript: [
          {
            id: "u1",
            role: "user",
            atMs: -5_000,
            parts: [{ type: "text", text: "hi" }],
          },
        ],
      }),
    );
    const rawStart = Math.round(playback.toRawMs(0));
    const rawEnd = Math.round(playback.toRawMs(playback.duration));
    // The raw start sits a preroll's length below the oldest content — the
    // synthetic lead-in has real coordinates, and a cut touching THIS edge
    // (not the content's start) is what makes a head trim.
    expect(rawStart).toBe(-5_000 - 1_200);
    expect(rawEnd).toBe(10_000);

    expect(
      classifyCut({ fromMs: rawStart, toMs: 2_000 }, rawStart, rawEnd),
    ).toBe("start");
    expect(classifyCut({ fromMs: 8_000, toMs: rawEnd }, rawStart, rawEnd)).toBe(
      "end",
    );
    expect(classifyCut({ fromMs: 2_000, toMs: 8_000 }, rawStart, rawEnd)).toBe(
      "mid",
    );
  });
});

describe("trimCutsToExportLimit", () => {
  /** Steady app input keeps a whole span uncompressed on the timeline. */
  const activity = (fromMs: number, toMs: number) => {
    const events: { kind: string; t: number }[] = [];
    for (let t = fromMs; t <= toMs; t += 400) {
      events.push({ kind: "pointer", t });
    }
    return events;
  };
  const withEvents = (
    durationMs: number,
    events: { kind: string; t: number }[],
    cuts?: { fromMs: number; toMs: number }[],
  ) =>
    recording({
      durationMs,
      events: [
        { kind: "segment", t: 0, version: 1 },
        ...events,
      ] as Recording["events"],
      ...(cuts ? { edits: { cuts } } : {}),
    });
  const durationWith = (
    rec: Recording,
    cuts: { fromMs: number; toMs: number }[],
  ) => buildPlayback({ ...rec, edits: { ...rec.edits, cuts } }).duration;

  it("returns null when the cut already fits", () => {
    const rec = withEvents(10_000, activity(0, 10_000));
    expect(trimCutsToExportLimit(rec, 30_000)).toBeNull();
  });

  it("trims an uncut session from its end to exactly the limit", () => {
    const rec = withEvents(45_000, activity(0, 45_000));
    const next = trimCutsToExportLimit(rec, 30_000);
    expect(next).not.toBeNull();
    const after = durationWith(rec, next ?? []);
    expect(after).toBeLessThanOrEqual(30_000);
    expect(after).toBeGreaterThan(29_900);
  });

  it("keeps existing mid cuts and shortens the EDITED cut, not the raw one", () => {
    const mid = { fromMs: 5_000, toMs: 12_000 };
    const rec = withEvents(60_000, activity(0, 60_000), [mid]);
    const next = trimCutsToExportLimit(rec, 30_000);
    expect(next).not.toBeNull();
    expect(next).toContainEqual(mid);
    expect(next).toHaveLength(2);
    const after = durationWith(rec, next ?? []);
    expect(after).toBeLessThanOrEqual(30_000);
    expect(after).toBeGreaterThan(29_900);
  });

  it("replaces an existing end trim instead of stacking another", () => {
    const rec = withEvents(60_000, activity(0, 60_000), [
      { fromMs: 50_000, toMs: 60_000 },
    ]);
    const next = trimCutsToExportLimit(rec, 30_000);
    expect(next).not.toBeNull();
    expect(next).toHaveLength(1);
    const after = durationWith(rec, next ?? []);
    expect(after).toBeLessThanOrEqual(30_000);
    expect(after).toBeGreaterThan(29_900);
  });

  it("never lands a hair over the limit when it falls inside an idle-compressed gap", () => {
    // Activity to 28s, dead air to 120s (compressed to a beat), activity
    // again: the limit instant maps deep into the raw gap, where a naive
    // rounded boundary re-expands to MORE than the limit.
    const rec = withEvents(125_000, [
      ...activity(0, 28_000),
      ...activity(120_000, 125_000),
    ]);
    const next = trimCutsToExportLimit(rec, 30_000);
    expect(next).not.toBeNull();
    const after = durationWith(rec, next ?? []);
    expect(after).toBeLessThanOrEqual(30_000);
    expect(after).toBeGreaterThan(29_900);
  });
});

describe("classifyTimelineGesture", () => {
  it("a quick click seeks — the few-px skid of a real (trackpad) click included", () => {
    expect(classifyTimelineGesture({ travelPx: 0, heldMs: 120 })).toBe("seek");
    expect(classifyTimelineGesture({ travelPx: 4, heldMs: 150 })).toBe("seek");
  });

  it("any drag past the click threshold selects — however quick", () => {
    expect(classifyTimelineGesture({ travelPx: 6, heldMs: 90 })).toBe("select");
    expect(classifyTimelineGesture({ travelPx: 80, heldMs: 90 })).toBe(
      "select",
    );
  });

  it("a held press selects even with almost no travel — the only way to express a sliver cut on a long recording", () => {
    expect(classifyTimelineGesture({ travelPx: 2, heldMs: 400 })).toBe(
      "select",
    );
  });
});

describe("keptTimelineRanges", () => {
  it("with nothing removed the whole session is one section", () => {
    expect(keptTimelineRanges(10_000, [])).toEqual([
      { fromMs: 0, toMs: 10_000 },
    ]);
  });

  it("merges overlapping removals and clamps to the session — sections are the clean complement", () => {
    expect(
      keptTimelineRanges(10_000, [
        { fromMs: -500, toMs: 2_000 },
        { fromMs: 3_000, toMs: 5_000 },
        { fromMs: 4_000, toMs: 6_500 },
        { fromMs: 9_000, toMs: 12_000 },
      ]),
    ).toEqual([
      { fromMs: 2_000, toMs: 3_000 },
      { fromMs: 6_500, toMs: 9_000 },
    ]);
  });
});

describe("consolidatedTranscript", () => {
  const transcript = [
    {
      id: "u1",
      role: "user",
      atMs: -10_000,
      parts: [{ type: "text" as const, text: "build an app" }],
    },
    {
      id: "a1",
      role: "assistant",
      atMs: -8_000,
      parts: [
        { type: "tool" as const, name: "archestra__render_app" },
        { type: "text" as const, text: "Done!" },
      ],
    },
    {
      id: "u2",
      role: "user",
      atMs: -4_000,
      parts: [{ type: "text" as const, text: "make it blue" }],
    },
    {
      id: "a2",
      role: "assistant",
      atMs: -2_000,
      parts: [{ type: "tool" as const, name: "archestra__edit_app" }],
    },
  ];

  it("replaces user prose with the one-shot prompt and agent prose with the closing response, keeping the real tool sequence", () => {
    const result = consolidatedTranscript(transcript, {
      description: "A blue app.",
      prompt: "Build a blue app",
      response: "Here is your blue app.",
    });

    // One user message — the consolidated prompt — at the first user slot.
    const users = result.filter((message) => message.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0].atMs).toBe(-10_000);
    expect(users[0].parts).toEqual([
      { type: "text", text: "Build a blue app" },
    ]);
    // The captured skill/tool activity replays exactly as it happened; the
    // assistant's prose folds into the single closing response at the end.
    const assistants = result.filter((message) => message.role === "assistant");
    expect(assistants.map((message) => message.parts)).toEqual([
      [{ type: "tool", name: "archestra__render_app" }],
      [{ type: "tool", name: "archestra__edit_app" }],
      [{ type: "text", text: "Here is your blue app." }],
    ]);
    const closing = result[result.length - 1];
    expect(closing.id).toBe("closing:enhanced-response");
    expect(closing.atMs).toBeGreaterThan(-2_000);
  });

  it("closes with a stock line when the bundle stores no response", () => {
    const result = consolidatedTranscript(transcript, {
      description: "A blue app.",
      prompt: "Build a blue app",
    });
    const closing = result[result.length - 1];
    expect(closing.role).toBe("assistant");
    const part = closing.parts[0];
    expect(part.type === "text" && part.text.length > 0).toBe(true);
  });

  it("is a no-op without an enhancement", () => {
    expect(consolidatedTranscript(transcript, undefined)).toBe(transcript);
  });

  describe("presentedTranscript (chat edits layered on top)", () => {
    const enhancement = { description: "A blue app.", prompt: "One-shot ask" };

    it("disabling the enhancement replays the original conversation", () => {
      const result = presentedTranscript(transcript, enhancement, {
        enhancementDisabled: true,
      });
      expect(result.map((message) => message.id)).toEqual([
        "u1",
        "a1",
        "u2",
        "a2",
      ]);
    });

    it("drops removed messages from the replay — user and assistant alike", () => {
      const result = presentedTranscript(transcript, undefined, {
        removedMessageIds: ["u2", "a2"],
      });
      expect(result.map((message) => message.id)).toEqual(["u1", "a1"]);
    });

    it("overrides user text but never the agent's captured output", () => {
      const result = presentedTranscript(transcript, undefined, {
        editedMessages: [
          { id: "u1", text: "sharper ask" },
          { id: "a1", text: "forged output" },
        ],
      });
      expect(result[0].parts).toEqual([{ type: "text", text: "sharper ask" }]);
      expect(result[1]).toBe(transcript[1]);
    });

    it("removals still apply while the enhancement consolidates the chat", () => {
      const result = presentedTranscript(transcript, enhancement, {
        removedMessageIds: ["a2"],
      });
      // The consolidated prompt survives (it has its own id); a2 is gone.
      expect(result.some((message) => message.id.endsWith(":enhanced"))).toBe(
        true,
      );
      expect(result.some((message) => message.id === "a2")).toBe(false);
    });
  });
});

describe("revealSchedule", () => {
  /** An agent burst: several messages stamped at (nearly) the same instant. */
  const burst = [
    { id: "u", role: "user", atMs: 0, parts: [{ type: "text", text: "hi" }] },
    ...Array.from({ length: 6 }, (_, i) => ({
      id: `a${i}`,
      role: "assistant",
      atMs: 1_000,
      parts: [{ type: "text", text: "x".repeat(400) }],
    })),
  ] as Parameters<typeof revealSchedule>[0];

  it("reveals a burst one message at a time instead of all at once", () => {
    const { schedule } = revealSchedule(burst, 60_000);
    const starts = burst
      .filter((m) => m.role === "assistant")
      .map((m) => schedule.get(m.id)?.start ?? 0);
    expect(starts).toStrictEqual([...starts].sort((a, b) => a - b));
    expect(new Set(starts).size).toBe(starts.length);
  });

  it("fits the burst inside the playback, so no message is stranded past the end", () => {
    // Unfitted, six 2.5s reveals would run to ~16s — far beyond this playback.
    const durationMs = 3_000;
    const { schedule, revealScale } = revealSchedule(burst, durationMs);
    expect(revealScale).toBeLessThan(1);
    for (const message of burst) {
      expect(schedule.get(message.id)?.end).toBeLessThanOrEqual(durationMs);
    }
  });

  it("leaves a schedule that already fits at full speed", () => {
    expect(revealSchedule(burst, 600_000).revealScale).toBe(1);
  });
});

describe("backfilledEnhancement", () => {
  const result = {
    description: "fresh description",
    prompt: "fresh prompt",
    response: "Here is what I built:\n- one thing\n- another",
    category: "Development",
  };

  it("adopts a generated response when the bundle has none", () => {
    // The failing case: an enhancement drafted before the closing response
    // existed. Every regenerate produced one and threw it away, so the replay
    // showed the stock line forever.
    const stored = { description: "kept", prompt: "kept prompt" };

    expect(backfilledEnhancement(stored, result, "App")).toStrictEqual({
      description: "kept",
      prompt: "kept prompt",
      response: result.response,
      category: "Development",
    });
  });

  it("never overwrites a response the builder already has", () => {
    const stored = {
      description: "kept",
      prompt: "kept prompt",
      response: "hand written",
    };

    expect(backfilledEnhancement(stored, result, "App")).toBeNull();
  });

  it("is a no-op when the regenerate produced no response", () => {
    expect(
      backfilledEnhancement(null, { ...result, response: null }, "App"),
    ).toBeNull();
    expect(
      backfilledEnhancement(null, { ...result, response: "  " }, "App"),
    ).toBeNull();
  });

  it("falls back to a described app name when nothing is stored", () => {
    const backfilled = backfilledEnhancement(null, result, "Weather");
    expect(backfilled?.description).toBe("fresh description");
    expect(backfilled?.response).toBe(result.response);
  });
});

describe("neutralizeAppScripts", () => {
  it("stops the app's own scripts but keeps the platform's", () => {
    const html = neutralizeAppScripts(
      `<script>game()</script><script data-archestra-app-sdk>sdk()</script>`,
    );
    expect(html).toContain(
      `<script type="application/archestra-replayed-script">game()`,
    );
    expect(html).toContain(`<script data-archestra-app-sdk>sdk()`);
  });

  it("stops module scripts by removing their type, not just appending one", () => {
    // The HTML parser drops duplicate attributes and keeps the FIRST, so a
    // replay type merely appended after `type="module"` leaves the module
    // type in force — the script executes and the app re-simulates itself
    // (fresh Math.random and all) on top of its own recording.
    const html = neutralizeAppScripts(
      `<script type="module">import * as THREE from "three"; boot()</script>`,
    );
    expect(html).toContain(
      `<script type="application/archestra-replayed-script">import * as THREE`,
    );
    expect(html).not.toContain(`type="module"`);
  });

  it("removes the app's type however it is quoted, keeping other attributes", () => {
    const html = neutralizeAppScripts(
      `<script defer type='module' src="/app.js"></script>` +
        `<script TYPE=module>a()</script>` +
        `<script type>b()</script>`,
    );
    expect(html).toContain(
      `<script defer src="/app.js" type="application/archestra-replayed-script">`,
    );
    expect(html).toContain(
      `<script type="application/archestra-replayed-script">a()`,
    );
    expect(html).toContain(
      `<script type="application/archestra-replayed-script">b()`,
    );
    expect(html).not.toMatch(/type=['"]?module/i);
  });

  it("hides the replayed app's scrollbars", () => {
    // The stage gives the app its recorded width and whatever height the
    // window leaves, so a shorter window overflows the recorded content and
    // the app draws scrollbars — light ones, which against a dark app read as
    // strips down the right and along the bottom. The offline renderer's
    // browser hides them of its own accord, so leaving them in the player also
    // makes the player and the exported video disagree.
    const html = neutralizeAppScripts("<body>app</body>");
    expect(html).toContain("scrollbar-width: none");
    expect(html).toContain("::-webkit-scrollbar");
    expect(html).toContain("<body>app</body>");
  });
});

describe("dominantViewport", () => {
  type Events = Parameters<typeof dominantViewport>[0];

  it("uses the only recorded size when there is just one", () => {
    const events: Events = [
      { kind: "viewport", t: 0, width: 1024, height: 768 },
      { kind: "pointer", t: 500, type: "click", x: 1, y: 1 },
    ];
    expect(dominantViewport(events)).toEqual({ width: 1024, height: 768 });
  });

  it("picks the size the app was played at, not the idle size it sat at longest", () => {
    // The app card sits narrow and inline through two minutes of building, then
    // opens wide in the side panel for fifteen seconds of play. Weighing by
    // wall-clock time alone picks the narrow idle size, and the game replays on
    // a "small screen" it was never played on — the exact bug this guards.
    const events: Events = [
      { kind: "viewport", t: 0, width: 448, height: 620 },
      { kind: "viewport", t: 120_000, width: 720, height: 940 },
    ];
    for (let t = 120_000; t <= 135_000; t += 250) {
      events.push({ kind: "pointer", t, type: "move", x: 10, y: 10 });
    }
    for (let t = 120_200; t <= 135_000; t += 500) {
      events.push({
        kind: "key",
        t,
        type: "down",
        key: "ArrowLeft",
        code: "ArrowLeft",
      });
    }
    expect(dominantViewport(events)).toEqual({ width: 720, height: 940 });
  });

  it("ignores a transient mount size in favor of the one that was used", () => {
    const events: Events = [
      { kind: "viewport", t: 0, width: 300, height: 40 }, // collapsed card at mount
      { kind: "viewport", t: 200, width: 900, height: 700 }, // settled to content
      { kind: "pointer", t: 1_000, type: "click", x: 5, y: 5 },
    ];
    expect(dominantViewport(events)).toEqual({ width: 900, height: 700 });
  });

  it("falls back to longest-on-screen time when there was no user interaction", () => {
    // A no-input recording (an app that only animates a canvas) has nothing to
    // weigh by interaction, so the size it lived at longest still wins.
    const events: Events = [
      { kind: "viewport", t: 0, width: 400, height: 600 },
      { kind: "viewport", t: 9_000, width: 800, height: 600 },
      { kind: "canvas", t: 9_500, sel: "canvas", blob: new Blob(["frame"]) },
    ];
    expect(dominantViewport(events)).toEqual({ width: 400, height: 600 });
  });
});

describe("replayStageFit", () => {
  it("scales uniformly by the limiting axis and centers the leftover", () => {
    // Stage wider than the recording's shape: height limits the scale and the
    // spare width splits evenly — the app is never stretched to fill.
    expect(
      replayStageFit({
        stageWidth: 1000,
        stageHeight: 400,
        viewport: { width: 400, height: 800 },
      }),
    ).toEqual({ scale: 0.5, offsetX: 400, offsetY: 0 });
    // Stage taller than the recording's shape: width limits instead.
    expect(
      replayStageFit({
        stageWidth: 400,
        stageHeight: 1000,
        viewport: { width: 800, height: 400 },
      }),
    ).toEqual({ scale: 0.5, offsetX: 0, offsetY: 400 });
  });

  it("fills a stage of the recorded shape edge to edge — the locked-aspect contract", () => {
    // A session recorded in the aspect-locked side panel replays in a stage
    // column of the same shape: one uniform factor for both dimensions, no
    // margins, no distortion. This is the exact bug this guards: a WebGL scene
    // recorded portrait must not replay squashed into a different aspect.
    const fit = replayStageFit({
      stageWidth: 800,
      stageHeight: 1000,
      viewport: { width: 400, height: 500 },
    });
    expect(fit).toEqual({ scale: 2, offsetX: 0, offsetY: 0 });
  });

  it("reports no fit while either box is sizeless, so a mid-mount measurement never collapses the app", () => {
    expect(
      replayStageFit({
        stageWidth: 0,
        stageHeight: 500,
        viewport: { width: 400, height: 800 },
      }),
    ).toBeNull();
    expect(
      replayStageFit({
        stageWidth: 500,
        stageHeight: 500,
        viewport: { width: 0, height: 0 },
      }),
    ).toBeNull();
  });
});

describe("replayRegionLayout", () => {
  it("lays the chat and app out as matching cards for a locked-aspect recording", () => {
    const layout = replayRegionLayout({
      screenWidth: 1920,
      screenHeight: 1080,
      viewport: { width: 400, height: 500 }, // the canonical 4:5
    });
    expect(layout.chatWidth).toBe(layout.appWidth);
    // Both cards carry the canonical aspect against the region height.
    expect(layout.chatWidth).toBe(Math.round(layout.regionHeight * (4 / 5)));
  });

  it("scales the whole region down uniformly when the screen is too narrow", () => {
    const viewport = { width: 400, height: 500 };
    const wide = replayRegionLayout({
      screenWidth: 1920,
      screenHeight: 1080,
      viewport,
    });
    const narrow = replayRegionLayout({
      screenWidth: 900,
      screenHeight: 1080,
      viewport,
    });
    // Fits the narrow screen…
    expect(narrow.chatWidth + narrow.appWidth).toBeLessThanOrEqual(
      Math.ceil(900 * 0.94) + 2,
    );
    // …by shrinking, not reshaping: the cards stay twins.
    expect(narrow.regionHeight).toBeLessThan(wide.regionHeight);
    expect(narrow.chatWidth).toBe(narrow.appWidth);
  });

  it("clamps a pathological recorded shape to a sane card", () => {
    const layout = replayRegionLayout({
      screenWidth: 1920,
      screenHeight: 1080,
      viewport: { width: 4000, height: 500 }, // an 8:1 ultrawide capture
    });
    expect(layout.appWidth).toBe(Math.round(layout.regionHeight * 2));
  });
});

describe("planPaintFlush", () => {
  type Paints = Parameters<typeof planPaintFlush>[0];
  const still = (sel: string, t: number, tag: string) => ({
    kind: "canvas" as const,
    t,
    sel,
    blob: new Blob([tag]),
  });
  const config = (sel: string, t: number) => ({
    kind: "video-config" as const,
    t,
    sel,
    codec: "vp8",
    codedWidth: 2,
    codedHeight: 2,
  });
  const chunk = (sel: string, t: number, type: "key" | "delta") => ({
    kind: "video-chunk" as const,
    t,
    sel,
    type,
    tsUs: t * 1_000,
    bytes: new Uint8Array([t]),
  });

  it("coalesces stills to the newest per canvas", () => {
    const a1 = still("#a", 1, "a1");
    const a2 = still("#a", 2, "a2");
    const b1 = still("#b", 1, "b1");
    expect(planPaintFlush([a1, a2, b1] as Paints)).toEqual([a2, b1]);
  });

  it("passes a mid-stream continuation through in order", () => {
    // No config crossed: the decoder holds state from earlier chunks, so every
    // chunk — deltas before this range's key included — must reach it.
    const events = [
      chunk("#v", 1, "delta"),
      chunk("#v", 2, "key"),
      chunk("#v", 3, "delta"),
    ];
    expect(planPaintFlush(events as Paints)).toEqual(events);
  });

  it("rebuilds a config-crossing range from the last keyframe", () => {
    const cfg = config("#v", 0);
    const k1 = chunk("#v", 1, "key");
    const d1 = chunk("#v", 2, "delta");
    const k2 = chunk("#v", 3, "key");
    const d2 = chunk("#v", 4, "delta");
    expect(planPaintFlush([cfg, k1, d1, k2, d2] as Paints)).toEqual([
      cfg,
      k2,
      d2,
      // The burst feeds a fresh decoder and then stops; without a flush the
      // decoder may hold every decoded frame and paint nothing.
      { kind: "video-flush", sel: "#v" },
    ]);
  });

  it("keeps a re-opened stream's newest config and its span", () => {
    // A resize mid-range re-configures the stream: only the last config and
    // the chunks after its last keyframe matter.
    const cfg1 = config("#v", 0);
    const k1 = chunk("#v", 1, "key");
    const cfg2 = config("#v", 2);
    const k2 = chunk("#v", 3, "key");
    const d2 = chunk("#v", 4, "delta");
    expect(planPaintFlush([cfg1, k1, cfg2, k2, d2] as Paints)).toEqual([
      cfg2,
      k2,
      d2,
      { kind: "video-flush", sel: "#v" },
    ]);
  });

  it("keeps independent canvases and streams apart", () => {
    const frame = still("#c", 2, "x");
    const cfg = config("#v", 0);
    const key = chunk("#v", 1, "key");
    expect(planPaintFlush([frame, cfg, key] as Paints)).toEqual([
      frame,
      cfg,
      key,
      { kind: "video-flush", sel: "#v" },
    ]);
  });
});

describe("pruneTrailingTrimEvents keeps buildPlayback identical", () => {
  // The offline renderer drives buildPlayback frame by frame, so the prune is
  // lossless iff buildPlayback's output — events, segments, transcript, duration
  // and the time mapping — is byte-for-byte the same on the pruned bundle.
  function recToBundle(rec: Recording): AppRecordingBundle {
    return {
      formatVersion: 1,
      app: { id: null, name: rec.appName },
      recording: {
        title: rec.title,
        startedAt: rec.startedAt,
        durationMs: rec.durationMs,
        // The prune reads only kind/t/durationMs; the frame payload field
        // (runtime blob vs stored base64) is opaque to it, so runtime-form
        // fixtures stand in for the stored form here.
        events:
          rec.events as unknown as AppRecordingBundle["recording"]["events"],
        segments: rec.segments,
        transcript: rec.transcript,
      },
      edits: rec.edits,
      enhancement: rec.enhancement,
      meta: {
        authorName: null,
        createdAt: rec.startedAt,
        platform: "archestra",
      },
    };
  }

  function pruned(rec: Recording): Recording {
    const out = pruneTrailingTrimEvents(recToBundle(rec));
    return {
      ...rec,
      events: out.recording.events as unknown as Recording["events"],
    };
  }

  function expectSamePlayback(rec: Recording) {
    const before = buildPlayback(rec);
    const after = buildPlayback(pruned(rec));
    expect(after.events).toEqual(before.events);
    expect(after.segments).toEqual(before.segments);
    expect(after.transcript).toEqual(before.transcript);
    expect(after.duration).toBe(before.duration);
    for (const ms of [0, before.duration / 2, before.duration]) {
      expect(after.toPlaybackMs(ms)).toBeCloseTo(before.toPlaybackMs(ms), 6);
      expect(after.toRawMs(ms)).toBe(before.toRawMs(ms));
    }
  }

  it("drops a full end trim's tail without changing playback", () => {
    const rec = recording({
      durationMs: 5_000,
      events: [
        { kind: "segment", t: 0, version: 1 },
        { kind: "canvas", t: 1_000, sel: "#c", blob: new Blob(["keep"]) },
        { kind: "canvas", t: 3_500, sel: "#c", blob: new Blob(["cut"]) },
        { kind: "dom", t: 4_200, op: "html", sel: "#a", html: "cut2" },
      ],
      edits: { cuts: [{ fromMs: 2_000, toMs: 5_000 }] },
    });
    expect(pruned(rec).events.length).toBeLessThan(rec.events.length);
    expectSamePlayback(rec);
  });

  it("preserves playback under an enhanced (final-version-only) replay", () => {
    const rec = recording({
      durationMs: 6_000,
      segments: [
        { version: 1, html: "<a></a>", atMs: 0 },
        { version: 2, html: "<b></b>", atMs: 2_000 },
      ],
      events: [
        { kind: "segment", t: 0, version: 1 },
        { kind: "canvas", t: 2_500, sel: "#c", blob: new Blob(["shown"]) },
        { kind: "canvas", t: 4_500, sel: "#c", blob: new Blob(["cut"]) },
      ],
      edits: { cuts: [{ fromMs: 4_000, toMs: 6_000 }] },
      enhancement: { description: "d", prompt: "build it" },
    });
    expect(pruned(rec).events.length).toBeLessThan(rec.events.length);
    expectSamePlayback(rec);
  });

  it("keeps an event just past the trim end (anchor within the eps slack)", () => {
    const rec = recording({
      durationMs: 5_000,
      events: [
        { kind: "segment", t: 0, version: 1 },
        { kind: "canvas", t: 3_000, sel: "#c", blob: new Blob(["cut"]) },
        {
          kind: "canvas",
          t: 4_990,
          sel: "#c",
          blob: new Blob(["tail-anchor"]),
        },
      ],
      edits: { cuts: [{ fromMs: 2_000, toMs: 4_980 }] },
    });
    expect(pruned(rec).events.length).toBeLessThan(rec.events.length);
    expectSamePlayback(rec);
  });

  it("leaves a mid cut alone and keeps playback identical", () => {
    const rec = recording({
      durationMs: 5_000,
      events: [
        { kind: "segment", t: 0, version: 1 },
        { kind: "canvas", t: 1_500, sel: "#c", blob: new Blob(["a"]) },
        { kind: "canvas", t: 4_000, sel: "#c", blob: new Blob(["b"]) },
      ],
      edits: { cuts: [{ fromMs: 1_000, toMs: 2_000 }] },
    });
    expect(pruned(rec).events.length).toBe(rec.events.length);
    expectSamePlayback(rec);
  });

  it("merges overlapping cuts that together reach the end", () => {
    const rec = recording({
      durationMs: 5_000,
      events: [
        { kind: "segment", t: 0, version: 1 },
        { kind: "canvas", t: 1_000, sel: "#c", blob: new Blob(["keep"]) },
        { kind: "canvas", t: 3_500, sel: "#c", blob: new Blob(["cut"]) },
        { kind: "canvas", t: 4_500, sel: "#c", blob: new Blob(["cut2"]) },
      ],
      edits: {
        cuts: [
          { fromMs: 3_000, toMs: 4_000 },
          { fromMs: 3_800, toMs: 5_000 },
        ],
      },
    });
    expect(pruned(rec).events.length).toBeLessThan(rec.events.length);
    expectSamePlayback(rec);
  });

  it("keeps a trim-straddling mcp so idle-gap compression is unchanged", () => {
    // The mcp fires at t=5000 (inside the trim) but STARTED at t-durationMs=1000
    // (before it), planting a compression anchor in the kept region. Naively
    // dropping the whole event would merge a >900ms idle gap and shorten the
    // video; the anchor must survive.
    const rec = recording({
      durationMs: 10_000,
      events: [
        { kind: "segment", t: 0, version: 1 },
        { kind: "mcp", t: 5_000, method: "tools/call", durationMs: 4_000 },
        { kind: "canvas", t: 3_000, sel: "#c", blob: new Blob(["kept"]) },
        { kind: "canvas", t: 9_000, sel: "#c", blob: new Blob(["cut"]) },
      ],
      edits: { cuts: [{ fromMs: 4_000, toMs: 10_000 }] },
    });
    // The tail canvas is dropped, but the straddling mcp is retained.
    expect(pruned(rec).events.length).toBe(rec.events.length - 1);
    expect(
      pruned(rec).events.some(
        (event) => event.kind === "mcp" && event.t === 5_000,
      ),
    ).toBe(true);
    expectSamePlayback(rec);
  });
});
