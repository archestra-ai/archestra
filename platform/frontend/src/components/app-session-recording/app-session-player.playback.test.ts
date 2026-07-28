import { describe, expect, it } from "vitest";
import { buildPlayback, revealSchedule } from "./app-session-player";

/**
 * The replayed session has to keep the ORDER the builder actually worked in.
 *
 * A recorded session is sequential by nature: the builder asks, reads the
 * reply, then touches the app, then goes back to chat. The timeline compresses
 * the dead waiting between those beats — that part is wanted, a build that took
 * forty minutes still has to make a short video. What is not wanted is the
 * compression reaching into time the CHAT PANE is still using: an assistant
 * reply reveals over real wall-clock time, and squeezing the gap after it below
 * that reveal replays the app's half on top of a reply still typing, which
 * invents a concurrency the session never had.
 *
 * These tests pin the invariant directly on the timeline arithmetic, which is
 * what every surface shares: the recorder's player/editor, the submission
 * review page, the review player docked in the chat panel, and the offline
 * video renderer all drive this one function.
 */

/** Long enough to reveal for the full STREAM_MAX_MS beat. */
const LONG_REPLY = "x".repeat(4_000);

function textPart(text: string) {
  return { type: "text" as const, text };
}

/**
 * The canonical sequential session, with a wide real gap on either side of the
 * app interaction so any overlap is the compression's doing and not a genuinely
 * simultaneous capture:
 *   t=0       the builder asks
 *   t=1_000   the agent answers at length
 *   t=30_000  the builder clicks in the app — long after the reply landed
 *   t=40_000  the builder returns to chat
 */
function sequentialSession() {
  const transcript = [
    { id: "ask-1", role: "user", atMs: 0, parts: [textPart("Build a thing.")] },
    {
      id: "reply-1",
      role: "assistant",
      atMs: 1_000,
      parts: [textPart(LONG_REPLY)],
    },
    {
      id: "ask-2",
      role: "user",
      atMs: 40_000,
      parts: [textPart("Now make it blue.")],
    },
  ];
  return {
    title: "sequential",
    startedAt: new Date(0).toISOString(),
    durationMs: 50_000,
    events: [
      {
        kind: "pointer" as const,
        t: 30_000,
        type: "click" as const,
        x: 5,
        y: 5,
      },
    ],
    segments: [{ version: 1, html: "<div>app</div>", atMs: 0 }],
    transcript,
    originalTranscript: transcript,
    appName: "Sequential App",
  };
}

/** Every message's reveal window on the built timeline, by message id. */
function revealWindows(recording: ReturnType<typeof sequentialSession>) {
  const playback = buildPlayback(recording as never);
  const { schedule, revealScale } = revealSchedule(
    playback.transcript,
    playback.duration,
  );
  return { playback, schedule, revealScale };
}

describe("replay ordering: the app pane never plays over a revealing chat", () => {
  it("holds the app interaction until the reply has finished revealing", () => {
    const { playback, schedule } = revealWindows(sequentialSession());

    const reply = schedule.get("reply-1");
    const click = playback.events.find((event) => event.kind === "pointer");

    expect(reply).toBeDefined();
    expect(click).toBeDefined();
    // The regression: the click used to land at 3000ms inside a 2100–3300ms
    // reveal, i.e. 300ms before the reply had finished drawing — for two
    // moments that sat 29 SECONDS apart in the real session.
    expect(click?.t).toBeGreaterThanOrEqual(reply?.end ?? 0);
  });

  it("keeps the whole chat/app/chat sequence in its recorded order", () => {
    const { playback, schedule } = revealWindows(sequentialSession());

    const firstAsk = schedule.get("ask-1")?.start ?? 0;
    const reply = schedule.get("reply-1");
    const click =
      playback.events.find((event) => event.kind === "pointer")?.t ?? 0;
    const secondAsk = schedule.get("ask-2")?.start ?? 0;

    expect(firstAsk).toBeLessThanOrEqual(reply?.start ?? 0);
    expect(reply?.end ?? 0).toBeLessThanOrEqual(click);
    expect(click).toBeLessThanOrEqual(secondAsk);
  });

  it("reveals at full speed rather than racing to fit the timeline", () => {
    // A scale below 1 means the reveal was sped up to fit a timeline too short
    // for it — the same overlap expressed as a squeezed animation instead of a
    // late one. Reserving the time in the timeline is what keeps this at 1.
    expect(revealWindows(sequentialSession()).revealScale).toBe(1);
  });

  it("still time-lapses dead waiting that no reveal is using", () => {
    // Guards the other direction: the fix reserves reveal time, it does NOT
    // abandon compression. Two user messages 30s apart carry no reveal between
    // them, so that stretch must still collapse rather than replay in full.
    const transcript = [
      { id: "a", role: "user", atMs: 0, parts: [textPart("first")] },
      { id: "b", role: "user", atMs: 30_000, parts: [textPart("second")] },
    ];
    const playback = buildPlayback({
      ...sequentialSession(),
      events: [],
      durationMs: 30_000,
      transcript,
      originalTranscript: transcript,
    } as never);

    expect(playback.duration).toBeLessThan(5_000);
  });
});
