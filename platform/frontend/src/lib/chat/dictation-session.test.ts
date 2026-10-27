import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DictationRecognition,
  DictationSession,
  type DictationState,
} from "./dictation-session";

class Recognition implements DictationRecognition {
  continuous = false;
  interimResults = false;
  lang = "";
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();
  onstart: DictationRecognition["onstart"] = null;
  onend: DictationRecognition["onend"] = null;
  onerror: DictationRecognition["onerror"] = null;
  onresult: DictationRecognition["onresult"] = null;
  result(...parts: string[]) {
    this.onresult?.({
      results: parts.map((text) => ({
        isFinal: true,
        0: { transcript: text },
      })),
    });
  }
}
function setup() {
  const runs: Recognition[] = [];
  const states: DictationState[] = [];
  const finished = vi.fn();
  const session = new DictationSession(
    () => {
      const run = new Recognition();
      runs.push(run);
      return run;
    },
    (state) => states.push(state),
    finished,
  );
  session.start();
  return { session, runs, states, finished };
}
afterEach(() => vi.useRealTimers());

describe("dictation user session", () => {
  it("keeps silence and pauses inside one session, retaining results across browser restarts", () => {
    const { session, runs, states, finished } = setup();
    runs[0].onstart?.();
    runs[0].result("Before the pause");
    runs[0].onerror?.({ error: "no-speech" });
    runs[0].onend?.();
    expect(runs).toHaveLength(2);
    expect(states.at(-1)?.phase).toBe("starting");
    runs[1].result("After the pause");
    session.finish(false);
    expect(finished).not.toHaveBeenCalled();
    runs[1].onend?.();
    expect(finished).toHaveBeenCalledExactlyOnceWith(
      "Before the pause After the pause",
      false,
    );
  });

  it("keeps restarting through extended silence without a session time limit", () => {
    vi.useFakeTimers();
    const { session, runs, states, finished } = setup();
    for (let index = 0; index < 20; index++) {
      vi.advanceTimersByTime(5_000);
      runs[index].onerror?.({ error: "no-speech" });
      runs[index].onend?.();
    }
    expect(runs).toHaveLength(21);
    expect(states.at(-1)?.phase).toBe("starting");
    expect(finished).not.toHaveBeenCalled();
    session.cancel();
  });

  it("waits for late final results, replaces repeated interim/final snapshots, and sends once", () => {
    const { session, runs, finished } = setup();
    runs[0].onresult?.({
      results: [{ isFinal: false, 0: { transcript: "A partial" } }],
    });
    session.finish(true);
    session.finish(true);
    session.start();
    runs[0].result("A final sentence", "A late segment");
    runs[0].result("A final sentence", "A late segment");
    expect(finished).not.toHaveBeenCalled();
    runs[0].onend?.();
    runs[0].onend?.();
    expect(finished).toHaveBeenCalledExactlyOnceWith(
      "A final sentence A late segment",
      true,
    );
    expect(runs[0].stop).toHaveBeenCalledOnce();
    expect(runs).toHaveLength(1);
    session.start();
    runs[1].result("Next message");
    session.finish(false);
    runs[1].onend?.();
    expect(finished).toHaveBeenLastCalledWith("Next message", false);
  });

  it("cancels pending sends and ignores late events after cancellation/unmount", () => {
    const { session, runs, finished, states } = setup();
    runs[0].result("Discard me");
    session.finish(true);
    session.cancel();
    runs[0].result("Late words");
    runs[0].onend?.();
    expect(finished).not.toHaveBeenCalled();
    expect(states.at(-1)).toMatchObject({ phase: "idle", transcript: "" });
    expect(runs[0].abort).toHaveBeenCalledOnce();
  });

  it("reports permission denial without restarting or sending; retry retains recovered words", () => {
    const { session, runs, finished, states } = setup();
    runs[0].result("Keep me");
    runs[0].onerror?.({ error: "not-allowed" });
    runs[0].onend?.();
    expect(runs).toHaveLength(1);
    expect(states.at(-1)?.error).toContain("permission denied");
    session.start();
    runs[1].result("And me");
    session.finish(false);
    runs[1].onend?.();
    expect(finished).toHaveBeenCalledExactlyOnceWith("Keep me And me", false);
  });

  it("falls back from an unsupported locale only once, after the browser ends", () => {
    const { runs, states } = setup();
    runs[0].onerror?.({ error: "language-not-supported" });
    expect(runs).toHaveLength(1);
    runs[0].onend?.();
    expect(runs[1].lang).toBe("");
    runs[1].onerror?.({ error: "language-not-supported" });
    runs[1].onend?.();
    expect(runs).toHaveLength(2);
    expect(states.at(-1)?.phase).toBe("error");
  });

  it("bounds rapid restart loops, and lets the user keep recovered text without sending", () => {
    const { session, runs, states, finished } = setup();
    for (let i = 0; i < 6; i++) runs[i].onend?.();
    expect(runs).toHaveLength(6);
    expect(states.at(-1)?.phase).toBe("error");
    session.finish(true);
    expect(finished).toHaveBeenCalledExactlyOnceWith("", false);
  });

  it("times out a stalled finalization without sending, retains interim text, and permits retry", () => {
    vi.useFakeTimers();
    const { session, runs, states, finished } = setup();
    runs[0].result("Recovered");
    session.finish(true);
    vi.advanceTimersByTime(10_000);
    expect(states.at(-1)).toMatchObject({
      phase: "error",
      transcript: "Recovered",
    });
    expect(finished).not.toHaveBeenCalled();
    runs[0].onend?.();
    session.finish(false);
    expect(finished).toHaveBeenCalledExactlyOnceWith("Recovered", false);
  });
});
