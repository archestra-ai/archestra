import { describe, expect, test } from "vitest";
import { resolvePlaceholders } from "./resolve-placeholders";

describe("resolvePlaceholders", () => {
  const timezone = "UTC";

  function isoDate(d: Date) {
    return d.toLocaleDateString("sv-SE", { timeZone: timezone });
  }

  test("replaces {{today}} with current date", () => {
    const result = resolvePlaceholders("Report for {{today}}", timezone);
    expect(result).toBe(`Report for ${isoDate(new Date())}`);
  });

  test("replaces {{yesterday}} with previous date", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const result = resolvePlaceholders("Data from {{yesterday}}", timezone);
    expect(result).toBe(`Data from ${isoDate(yesterday)}`);
  });

  test("replaces {{last_week}} with 7-day range ending yesterday", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const weekStart = new Date(yesterday);
    weekStart.setDate(weekStart.getDate() - 6);
    const expected = `${isoDate(weekStart)} to ${isoDate(yesterday)}`;
    const result = resolvePlaceholders("Sales for {{last_week}}", timezone);
    expect(result).toBe(`Sales for ${expected}`);
  });

  test("replacement is case-insensitive", () => {
    const result = resolvePlaceholders(
      "{{TODAY}} {{Yesterday}} {{LAST_WEEK}}",
      timezone,
    );
    const today = isoDate(new Date());
    expect(result).toContain(today);
    expect(result).not.toContain("{{TODAY}}");
    expect(result).not.toContain("{{Yesterday}}");
    expect(result).not.toContain("{{LAST_WEEK}}");
  });

  test("unknown placeholders are left as-is", () => {
    const result = resolvePlaceholders("Hello {{unknown}} world", timezone);
    expect(result).toBe("Hello {{unknown}} world");
  });

  test("template without placeholders is returned unchanged", () => {
    const template = "Run the daily report and summarize findings.";
    expect(resolvePlaceholders(template, timezone)).toBe(template);
  });

  test("respects IANA timezone for date calculation", () => {
    const result = resolvePlaceholders("{{today}}", "America/New_York");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("tolerates whitespace inside the placeholder braces", () => {
    const result = resolvePlaceholders("Stats for {{  today  }}", timezone);
    expect(result).toBe(`Stats for ${isoDate(new Date())}`);
  });

  test("accepts 'last week' (with space) as an alias for last_week", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const weekStart = new Date(yesterday);
    weekStart.setDate(weekStart.getDate() - 6);
    const expected = `${isoDate(weekStart)} to ${isoDate(yesterday)}`;
    const result = resolvePlaceholders("Sales for {{last week}}", timezone);
    expect(result).toBe(`Sales for ${expected}`);
  });

  test("replaces {{tomorrow}} with next day", () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const result = resolvePlaceholders("Plan for {{tomorrow}}", timezone);
    expect(result).toBe(`Plan for ${isoDate(tomorrow)}`);
  });

  test("replaces {{now}} with ISO-8601 timestamp", () => {
    const result = resolvePlaceholders("Ran at {{now}}", timezone);
    expect(result).toMatch(
      /^Ran at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });
});
