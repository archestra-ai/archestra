import { expect, test } from "vitest";
import { scenarioWitnesses } from "./scenario-witnesses";

test("unsupported selectors and unsafe keys produce no fabricated call", () => {
  for (const name of [
    "mcp/mail/*",
    "mcp/mail/send(recipient:a|b)",
    "mcp/mail/send(__proto__:x)",
  ]) {
    const result = scenarioWitnesses(
      `[policy]\nversion = 2\n[[policy.tool]]\nname = '${name}'\ndelta = {}\n`,
    );
    expect(result.calls).toEqual([]);
    expect(result.skipped).toHaveLength(1);
  }
});

test("limits candidate expansion and de-duplicates repeated calls", () => {
  const declaration = (n: number) =>
    `[[policy.tool]]\nname = 'records__action${n}'\ndelta = {}\n`;
  const result = scenarioWitnesses(
    `[policy]\nversion = 2\n${declaration(0)}${Array.from({ length: 100 }, (_, i) => declaration(i)).join("")}`,
  );
  expect(result.calls).toHaveLength(16);
  expect(result.limited).toBe(true);
  expect(new Set(result.calls.map((call) => call.tool)).size).toBe(16);
});
