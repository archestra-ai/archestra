import { expect, test } from "vitest";
import { boundedEmailContext } from "./email-context";

test("small command/history parts are unchanged", () => {
  expect(
    boundedEmailContext({
      body: "current",
      history: "earlier\n\n",
      maxBytes: 256,
    }),
  ).toMatchObject({
    body: "current",
    history: "earlier\n\n",
    message: "earlier\n\n[Current message from user]: current",
  });
});
test.for([
  "",
  "earlier ".repeat(100),
])("oversized current text stays bounded with history=%s", (history) => {
  const result = boundedEmailContext({
    body: "current ".repeat(100),
    history,
    maxBytes: 256,
  });
  expect(Buffer.byteLength(result.message, "utf8")).toBeLessThanOrEqual(256);
  expect(result.message).toContain("Message truncated");
  expect(result.message).toContain("current");
});
test("oversized history cannot crowd out the current command", () => {
  const result = boundedEmailContext({
    body: "Execute this current command",
    history: "old context ".repeat(100),
    maxBytes: 256,
  });
  expect(Buffer.byteLength(result.message, "utf8")).toBeLessThanOrEqual(256);
  expect(result.body).toContain("Execute this current command");
  expect(result.history.length).toBeLessThan(1200);
  expect(result.message).toBe(
    `${result.history}[Current message from user]: ${result.body}`,
  );
});
test("UTF8 framing and clipped parts never exceed the budget or split code points", () => {
  const result = boundedEmailContext({
    body: "\u{1f600}".repeat(100),
    history: "\u{1f600}".repeat(100),
    maxBytes: 256,
  });
  expect(Buffer.byteLength(result.message, "utf8")).toBeLessThanOrEqual(256);
  expect(result.message).not.toContain("\ufffd");
});
