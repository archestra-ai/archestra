import { expect, test } from "vitest";
import { scenarioContent, scenarioWitnesses } from "./scenario-witnesses";

test("generates concrete selector arguments and configured alias bindings", () => {
  const generated = scenarioWitnesses(`[server_aliases]
mail = ['mail_prod']
[policy]
version = 2
[[policy.tool]]
name = 'mcp/mail/send(recipient:internal/*)'
parameters = { type = 'object', required = ['body'], properties = { body = { type = 'string' } } }
delta = {}
`);
  expect(generated.calls).toEqual([
    {
      tool: "mcp/mail_prod/send",
      arguments: { body: "example", recipient: "internal/example" },
    },
  ]);
  expect(scenarioContent(generated.calls[0], "deny")).toContain(
    'recipient: "internal/example"',
  );
});

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
