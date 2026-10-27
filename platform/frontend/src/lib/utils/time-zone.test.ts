import { afterEach, describe, expect, test, vi } from "vitest";
import { browserTimeZone } from "./time-zone";

describe("browserTimeZone", () => {
  afterEach(() => vi.restoreAllMocks());

  const reports = (timeZone: string | undefined) =>
    vi
      .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockReturnValue({ timeZone } as Intl.ResolvedDateTimeFormatOptions);

  test("sends the zone the browser reports, current names included", () => {
    reports("Asia/Kolkata");
    expect(browserTimeZone()).toBe("Asia/Kolkata");
  });

  test("falls back to UTC for a zone the API would refuse, or none", () => {
    reports("+05:30");
    expect(browserTimeZone()).toBe("UTC");
    reports(undefined);
    expect(browserTimeZone()).toBe("UTC");
  });
});
