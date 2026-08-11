import { describe, expect, test } from "vitest";
import { parseRumBatchSetting, parseRumSampleRate } from "./config";

describe("parseRumSampleRate", () => {
  test("unset records everything", () => {
    expect(parseRumSampleRate(undefined)).toBe(1);
  });

  test("accepts the 0-1 range including the edges", () => {
    expect(parseRumSampleRate("0.25")).toBe(0.25);
    expect(parseRumSampleRate("0")).toBe(0);
    expect(parseRumSampleRate("1")).toBe(1);
  });

  test("out-of-range or garbage falls back to 1, never off", () => {
    expect(parseRumSampleRate("1.5")).toBe(1);
    expect(parseRumSampleRate("-0.1")).toBe(1);
    expect(parseRumSampleRate("nope")).toBe(1);
  });
});

describe("parseRumBatchSetting", () => {
  test("positive integers pass, everything else keeps the default", () => {
    expect(parseRumBatchSetting(undefined, 512)).toBe(512);
    expect(parseRumBatchSetting("4096", 512)).toBe(4096);
    expect(parseRumBatchSetting("0", 512)).toBe(512);
    expect(parseRumBatchSetting("-1", 512)).toBe(512);
    expect(parseRumBatchSetting("abc", 512)).toBe(512);
  });
});
