import { describe, expect, test } from "vitest";
import { repairLoneSurrogates } from "./lone-surrogates";

// 📎 — one astral character, two UTF-16 code units.
const EMOJI = "\u{1F4CE}";
const HIGH = "\uD83D";
const LOW = "\uDCCE";
const REPLACEMENT = "�";

describe("repairLoneSurrogates", () => {
  test("replaces a stranded high surrogate", () => {
    const { value, repaired } = repairLoneSurrogates({ text: `a${HIGH}b` });
    expect(value).toEqual({ text: `a${REPLACEMENT}b` });
    expect(repaired).toBe(1);
  });

  test("replaces a stranded low surrogate", () => {
    const { value, repaired } = repairLoneSurrogates({ text: `a${LOW}b` });
    expect(value).toEqual({ text: `a${REPLACEMENT}b` });
    expect(repaired).toBe(1);
  });

  test("leaves well-formed pairs alone", () => {
    const { value, repaired } = repairLoneSurrogates({
      text: `hi ${EMOJI} there ${EMOJI}`,
    });
    expect(value).toEqual({ text: `hi ${EMOJI} there ${EMOJI}` });
    expect(repaired).toBe(0);
  });

  test("repairs a lone half sitting next to an intact pair", () => {
    // The regex must not consume the valid pair's high surrogate while
    // matching the stray one before it.
    const { value, repaired } = repairLoneSurrogates(`${HIGH}${EMOJI}`);
    expect(value).toBe(`${REPLACEMENT}${EMOJI}`);
    expect(repaired).toBe(1);
  });

  test("repairs a run of stranded halves", () => {
    const { repaired } = repairLoneSurrogates(`${HIGH}${HIGH}${LOW}${LOW}`);
    // High+high: first is lone, second pairs with the following low. The
    // trailing low is then lone. Two repairs, one surviving pair.
    expect(repaired).toBe(2);
  });

  test("returns a clean body by reference, without copying", () => {
    // The hot path: every well-formed request. Identity, not just equality —
    // a large transcript must not be cloned on the way to the provider.
    const body = {
      model: "m",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    };
    const { value, repaired } = repairLoneSurrogates(body);
    expect(value).toBe(body);
    expect(repaired).toBe(0);
  });

  test("shares untouched subtrees when repairing elsewhere", () => {
    const clean = { role: "system", content: "stay" };
    const body = { messages: [clean, { role: "user", content: HIGH }] };
    const { value } = repairLoneSurrogates(body);
    expect(value).not.toBe(body);
    expect((value as { messages: unknown[] }).messages[0]).toBe(clean);
  });

  test("reaches into nested arrays and objects", () => {
    const { value, repaired } = repairLoneSurrogates({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "fine" },
            { type: "tool_result", content: [{ text: `edit ${HIGH}` }] },
          ],
        },
      ],
    });
    expect(repaired).toBe(1);
    expect(JSON.stringify(value)).toContain(REPLACEMENT);
  });

  test("repairs object keys as well as values", () => {
    const { value, repaired } = repairLoneSurrogates({ [`k${HIGH}`]: "v" });
    expect(value).toEqual({ [`k${REPLACEMENT}`]: "v" });
    expect(repaired).toBe(1);
  });

  test("passes non-JSON values through untouched", () => {
    const buffer = Buffer.from("bytes");
    const date = new Date(0);
    const body = { buffer, date, n: 1, ok: true, nothing: null };
    const { value, repaired } = repairLoneSurrogates(body);
    expect(repaired).toBe(0);
    const passed = value as typeof body;
    expect(passed.buffer).toBe(buffer);
    expect(passed.date).toBe(date);
  });

  test("repair makes the serialized body decode back to well-formed text", () => {
    // The precise defect. JSON.stringify turns a lone surrogate into a bare
    // \uD83D escape — ASCII, so the JSON *text* is fine and travels intact.
    // Decoding it, though, yields an unpaired surrogate, which has no UTF-8
    // representation: strict server-side parsers (serde_json, Jackson) refuse
    // the escape outright, which is the 400 the user sees.
    const poisoned = { messages: [{ content: `Applied 1 edit ${HIGH}` }] };
    const before = JSON.parse(JSON.stringify(poisoned)) as typeof poisoned;
    expect(hasLoneSurrogate(before.messages[0].content)).toBe(true);

    const { value } = repairLoneSurrogates(poisoned);
    const after = JSON.parse(JSON.stringify(value)) as typeof poisoned;
    expect(hasLoneSurrogate(after.messages[0].content)).toBe(false);
    // And it now survives a UTF-8 round trip without being mangled.
    const text = after.messages[0].content;
    expect(Buffer.from(text, "utf8").toString("utf8")).toBe(text);
  });
});

/** Mirrors the module's own detection, so the test asserts independently. */
function hasLoneSurrogate(text: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
    text,
  );
}
