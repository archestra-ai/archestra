import { describe, expect, test } from "vitest";
import { repairHarmonyToolName, repairToolInputJson } from "./tool-call-repair";

const AVAILABLE = [
  "archestra__run_command",
  "archestra__search_tools",
  "context7__resolve-library-id",
];

describe("repairHarmonyToolName", () => {
  test("strips a harmony channel marker and matches the registered tool", () => {
    expect(
      repairHarmonyToolName(
        "archestra__run_command<|channel|>commentary",
        AVAILABLE,
      ),
    ).toBe("archestra__run_command");
  });

  test("strips any harmony token, not just channel", () => {
    expect(
      repairHarmonyToolName(
        "archestra__run_command<|constrain|>json",
        AVAILABLE,
      ),
    ).toBe("archestra__run_command");
    expect(
      repairHarmonyToolName(
        "archestra__search_tools<|channel|>analysis",
        AVAILABLE,
      ),
    ).toBe("archestra__search_tools");
  });

  test("repairs non-archestra MCP tools too", () => {
    expect(
      repairHarmonyToolName(
        "context7__resolve-library-id<|channel|>final",
        AVAILABLE,
      ),
    ).toBe("context7__resolve-library-id");
  });

  test("returns null for an already-valid name (no token)", () => {
    expect(
      repairHarmonyToolName("archestra__run_command", AVAILABLE),
    ).toBeNull();
  });

  test("returns null when the cleaned prefix is not a registered tool", () => {
    expect(
      repairHarmonyToolName(
        "archestra__ghost_tool<|channel|>commentary",
        AVAILABLE,
      ),
    ).toBeNull();
  });

  test("returns null when the token is at the very start (nothing left)", () => {
    expect(
      repairHarmonyToolName("<|channel|>commentary", AVAILABLE),
    ).toBeNull();
  });

  test("returns null for a genuinely-unknown name without a token", () => {
    expect(repairHarmonyToolName("totally_made_up", AVAILABLE)).toBeNull();
  });

  test("does not strip an unclosed `<|` that is not a harmony token", () => {
    // a partial/garbage marker must not silently re-map to a different tool.
    expect(
      repairHarmonyToolName("archestra__run_command<|garbage", AVAILABLE),
    ).toBeNull();
  });

  test("does not strip a closed sentinel outside the harmony vocabulary", () => {
    // a closed `<|word|>` that is not a real harmony token must not trigger
    // repair — only the registered-tool match would otherwise gate it.
    expect(
      repairHarmonyToolName(
        "archestra__run_command<|garbage|>suffix",
        AVAILABLE,
      ),
    ).toBeNull();
  });

  test("splits on the first harmony token when several are present", () => {
    expect(
      repairHarmonyToolName(
        "archestra__run_command<|constrain|>json<|channel|>commentary",
        AVAILABLE,
      ),
    ).toBe("archestra__run_command");
  });
});

describe("repairToolInputJson", () => {
  test("returns null for already-valid JSON (nothing to repair)", () => {
    expect(repairToolInputJson('{"name":"foo","content":"bar"}')).toBeNull();
    expect(
      repairToolInputJson('{"a":1,"b":[1,2,3],"c":{"d":true}}'),
    ).toBeNull();
  });

  test("escapes a raw newline inside a string value and re-parses", () => {
    // A literal newline byte inside the quoted value — illegal raw JSON.
    const raw = '{"content":"line one\nline two"}';
    const repaired = repairToolInputJson(raw);
    expect(repaired).not.toBeNull();
    const parsed = JSON.parse(repaired as string);
    expect(parsed.content).toBe("line one\nline two");
  });

  test("escapes a raw tab inside a string value", () => {
    const raw = '{"content":"col1\tcol2"}';
    const repaired = repairToolInputJson(raw);
    expect(repaired).not.toBeNull();
    expect(JSON.parse(repaired as string).content).toBe("col1\tcol2");
  });

  test("escapes carriage return and other control chars", () => {
    const raw = '{"content":"a\rbc"}';
    const repaired = repairToolInputJson(raw);
    expect(repaired).not.toBeNull();
    const parsed = JSON.parse(repaired as string);
    expect(parsed.content).toBe("a\rbc");
    // The unusual control char must come back as a \uXXXX escape.
    expect(repaired).toContain("\\u0001");
  });

  test("repairs raw control chars in a nested object/array value", () => {
    const raw = '{"skill":{"files":["a\nb","c\td"]},"name":"x"}';
    const repaired = repairToolInputJson(raw);
    expect(repaired).not.toBeNull();
    const parsed = JSON.parse(repaired as string);
    expect(parsed.skill.files).toEqual(["a\nb", "c\td"]);
    expect(parsed.name).toBe("x");
  });

  test("preserves already-escaped sequences without double-escaping", () => {
    // Valid JSON that already contains escaped \n and \" — but make it
    // need a repair elsewhere so the function actually returns a string.
    const raw = '{"content":"escaped \\n and \\" stay\nplus a raw newline"}';
    const repaired = repairToolInputJson(raw);
    expect(repaired).not.toBeNull();
    const parsed = JSON.parse(repaired as string);
    // The pre-escaped sequences decode to a real newline and quote; the raw
    // newline is now also a real newline. No literal backslash doubling.
    expect(parsed.content).toBe('escaped \n and " stay\nplus a raw newline');
    expect(repaired).not.toContain("\\\\n");
  });

  test("leaves insignificant whitespace control chars outside strings alone", () => {
    // Raw newlines between tokens (outside any string) are legal JSON
    // whitespace; input is already valid so it returns null.
    const raw = '{\n  "a": 1,\n  "b": "ok"\n}';
    expect(repairToolInputJson(raw)).toBeNull();
  });

  test("returns null for unescaped inner quotes (unrecoverable)", () => {
    // The control-char pass cannot disambiguate an inner quote; it must not
    // pretend to fix this — return null and let the model re-ask handle it.
    const raw = '{"content":"he said "hi" to me"}';
    expect(repairToolInputJson(raw)).toBeNull();
  });

  test("returns null for genuinely-unrecoverable garbage", () => {
    expect(repairToolInputJson("{not json at all")).toBeNull();
    expect(repairToolInputJson("}}}{{{")).toBeNull();
  });

  test("repairs the realistic skill-content failure mode", () => {
    // create_skill / update_skill with a multi-line markdown content blob
    // carrying raw newlines — the reported failure.
    const raw =
      '{"name":"my-skill","content":"# Title\n\nSome body text.\n- bullet\n"}';
    const repaired = repairToolInputJson(raw);
    expect(repaired).not.toBeNull();
    const parsed = JSON.parse(repaired as string);
    expect(parsed.name).toBe("my-skill");
    expect(parsed.content).toBe("# Title\n\nSome body text.\n- bullet\n");
  });
});
