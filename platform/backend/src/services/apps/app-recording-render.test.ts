import { describe, expect, test } from "@/test";
import { admitRender, recordingVideoFileName } from "./app-recording-render";

describe("recordingVideoFileName", () => {
  test("slugifies the app's title into an mp4 name", () => {
    expect(recordingVideoFileName("PR Dashboard")).toBe(
      "pr-dashboard-session.mp4",
    );
  });

  test("collapses punctuation and trims the edges", () => {
    expect(recordingVideoFileName("  Weather — Today!  ")).toBe(
      "weather-today-session.mp4",
    );
  });

  test("falls back when a title slugifies to nothing", () => {
    // A title of only punctuation would otherwise produce a dotfile.
    expect(recordingVideoFileName("—— !!! ——")).toBe("app-session.mp4");
  });
});

describe("admitRender", () => {
  test("refuses a second render while one is already running for that person", () => {
    const release = admitRender("user-1");
    // The export button disables itself, but it is one fetch away from being
    // bypassed and it forgets it was ever pressed once the player is closed
    // and reopened, so the refusal has to live here.
    expect(() => admitRender("user-1")).toThrow(/already being prepared/);
    release();
    admitRender("user-1")();
  });

  test("caps how many render at once across everyone", () => {
    const first = admitRender("user-2");
    const second = admitRender("user-3");
    // A per-person limit alone still lets a handful of people between them
    // hold every browser the host can afford.
    expect(() => admitRender("user-4")).toThrow(/Too many/);
    first();
    const third = admitRender("user-4");
    second();
    third();
  });

  test("releasing twice frees only the slot it took", () => {
    const release = admitRender("user-5");
    release();
    // A double release must not hand back a slot that was never held, or a
    // retry after a failed render would quietly widen the ceiling.
    release();
    const first = admitRender("user-6");
    const second = admitRender("user-7");
    expect(() => admitRender("user-8")).toThrow(/Too many/);
    first();
    second();
  });
});
