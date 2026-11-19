import { expect, test } from "vitest";
import { grokCanonicalToolName, grokToolName } from "./grok-tool-names";

test.each([
  "archestra__ask_user",
  "archestra__execute_remedy_plan",
  "provider__read_note",
  "grokxprovider_5f_name",
  "provider.with.dots/tool",
  "日本語__read",
])("Grok wire names are unambiguous and reversible without collisions: %s", (name) => {
  const encoded = grokToolName(name);
  expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(encoded).not.toContain("__");
  expect(grokCanonicalToolName(encoded)).toBe(name);
  expect(grokToolName(encoded)).not.toBe(encoded);
});

test.each([
  "archestra__ask_user",
  "grokx",
  "grokx_5F",
  "grokx_61",
  "grokx_ff",
  "grokx_",
  "grokx__ask",
  "grokx../escape",
])("malformed or noncanonical wire spellings never acquire a canonical identity: %s", (name) => {
  expect(grokCanonicalToolName(name)).toBeUndefined();
});
