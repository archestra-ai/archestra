// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  getTerminalRecordingLinkUrl,
  inferTerminalRecordingLinks,
} from "./terminal-recording-links";
import type { snapshotTerminalRecording } from "./terminal-recording-snapshot";

type Lines = ReturnType<typeof snapshotTerminalRecording>["lines"];

describe("getTerminalRecordingLinkUrl", () => {
  it.each([
    ["https://example.com/report", "https://example.com/report"],
    ["HTTP://localhost:3000", "http://localhost:3000/"],
    ["file:///tmp/report.pdf", "file:///tmp/report.pdf"],
    ["file://server/share/report.pdf", "file://server/share/report.pdf"],
  ])("accepts the supported target %s", (text, expected) => {
    expect(getTerminalRecordingLinkUrl(text)).toBe(expected);
  });
  it.each([
    "javascript:alert(1)",
    "data:text/html,hello",
    "ftp://example.com/report",
    "https:///report",
    "http://",
    "https://[broken]/report",
    "https://example.com/\u001b]8;;javascript:alert(1)",
    "/tmp/report.pdf",
    "relative/report.pdf",
  ])("rejects unsupported or malformed target %s", (text) => {
    expect(getTerminalRecordingLinkUrl(text)).toBeNull();
  });
});

it("excludes sentence punctuation, preserves balanced parentheses and recognizes file and IPv6 URLs", () => {
  const value = lines(
    "(https://example.com/wiki/Title_(part)). http://[::1]:3000/report! file:///tmp/report.pdf",
  );
  inferTerminalRecordingLinks(value);
  expect(
    value[0].runs.filter((run) => run.url).map((run) => [run.text, run.url]),
  ).toEqual([
    [
      "https://example.com/wiki/Title_(part)",
      "https://example.com/wiki/Title_(part)",
    ],
    ["http://[::1]:3000/report", "http://[::1]:3000/report"],
    ["file:///tmp/report.pdf", "file:///tmp/report.pdf"],
  ]);
});

it("does not link unsupported schemes, bare paths or URLs embedded in identifiers", () => {
  const value = lines(
    "javascript:https://example.com /tmp/report.pdf wordhttps://example.com https:///broken",
  );
  inferTerminalRecordingLinks(value);
  expect(value[0].runs.every((run) => run.url === undefined)).toBe(true);
});

it("links across styled soft wraps and extraction boundaries without altering cell geometry", () => {
  const value = lines("界 ", "https://example.com/", "e\u0301", "report.");
  value[0].row = 1999;
  value[0].runs[0] = {
    ...value[0].runs[0],
    text: "界",
    cells: 2,
    fixedWidth: true,
  };
  value[0].runs.push({
    column: 2,
    text: " ",
    cells: 1,
    fixedWidth: false,
    style: {},
  });
  value.slice(1).forEach((line, index) => {
    line.row = 2000 + index;
    line.wrapped = true;
  });
  value[2].runs[0] = {
    ...value[2].runs[0],
    cells: 1,
    fixedWidth: true,
    style: { color: "red" },
  };
  const expected = structuredClone(value);
  inferTerminalRecordingLinks(value);
  const linked = value.flatMap((line) => line.runs).filter((run) => run.url);
  expect(linked.map((run) => run.text).join("")).toBe(
    "https://example.com/e\u0301report",
  );
  expect(
    linked.every((run) => run.url === "https://example.com/e%CC%81report"),
  ).toBe(true);
  expect(value[2].runs[0]).toMatchObject(expected[2].runs[0]);
  expect(value[3].runs.map((run) => [run.column, run.cells])).toEqual([
    [0, 6],
    [6, 1],
  ]);
  const once = structuredClone(value);
  inferTerminalRecordingLinks(value);
  expect(value).toEqual(once);
});

it("never infers a URL through a hard line break", () => {
  const value = lines("https://", "example.com/report");
  inferTerminalRecordingLinks(value);
  expect(value.flatMap((line) => line.runs).every((run) => !run.url)).toBe(
    true,
  );
});

function lines(...text: string[]): Lines {
  return text.map((text, row) => ({
    row,
    wrapped: false,
    runs: [
      { text, column: 0, cells: text.length, fixedWidth: false, style: {} },
    ],
  }));
}
