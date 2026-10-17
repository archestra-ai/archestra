// @vitest-environment node
import { describe, expect, test } from "vitest";
import { greetingName, pickChatGreeting } from "./chat-landing-greeting";

describe("pickChatGreeting", () => {
  test("follows the local hour across the day's boundaries", () => {
    const at = (hour: number) =>
      pickChatGreeting({ date: new Date(2026, 9, 17, hour, 30) });
    expect(at(4)).toMatch(
      /^(Up late|Burning the midnight oil|Welcome back)\.$/,
    );
    expect(at(5)).toMatch(/^(Good morning|Morning|Welcome back)\.$/);
    expect(at(12)).toMatch(/^(Good afternoon|Afternoon|Welcome back)\.$/);
    expect(at(18)).toMatch(/^(Good evening|Evening|Welcome back)\.$/);
  });

  test("keeps one greeting for the whole day but varies across days", () => {
    const morning = new Date(2026, 9, 17, 9);
    const lateMorning = new Date(2026, 9, 17, 11, 59);
    expect(pickChatGreeting({ date: morning })).toBe(
      pickChatGreeting({ date: lateMorning }),
    );
    const week = Array.from({ length: 7 }, (_, d) =>
      pickChatGreeting({ date: new Date(2026, 9, 17 + d, 9) }),
    );
    expect(new Set(week).size).toBeGreaterThan(1);
  });

  test("greets by first name", () => {
    expect(
      pickChatGreeting({
        date: new Date(2026, 9, 17, 9),
        name: "Ada Lovelace",
      }),
    ).toMatch(/, Ada\.$/);
  });
});

describe("greetingName", () => {
  test("drops role-like account names instead of greeting them", () => {
    expect(greetingName("Admin")).toBeUndefined();
    expect(greetingName("  administrator ")).toBeUndefined();
    expect(greetingName("")).toBeUndefined();
    expect(greetingName(null)).toBeUndefined();
    expect(greetingName("Adam Smith")).toBe("Adam");
  });
});
