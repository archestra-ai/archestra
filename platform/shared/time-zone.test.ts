import { describe, expect, test } from "vitest";
import { isKnownTimeZone, isNamedTimeZone } from "./time-zone";

describe("time zones", () => {
  test("accepts the names browsers report, current and older spellings", () => {
    for (const zone of [
      "UTC",
      "Etc/UTC",
      "Asia/Kolkata",
      "Asia/Calcutta",
      "Europe/Kyiv",
      "Asia/Ho_Chi_Minh",
      "America/Argentina/Buenos_Aires",
      "Etc/GMT+5",
    ]) {
      expect(isNamedTimeZone(zone), zone).toBe(true);
      expect(isKnownTimeZone(zone), zone).toBe(true);
    }
  });

  test("names only: an offset is known but not named", () => {
    expect(isKnownTimeZone("+05:30")).toBe(true);
    expect(isNamedTimeZone("+05:30")).toBe(false);
  });

  test("refuses what no runtime knows", () => {
    for (const zone of [
      "",
      "Mars/Olympus_Mons",
      "Europe/Kyiv; drop",
      "../UTC",
    ]) {
      expect(isKnownTimeZone(zone) && isNamedTimeZone(zone), zone).toBe(false);
    }
  });
});
