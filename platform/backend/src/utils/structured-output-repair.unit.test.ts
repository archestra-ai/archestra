import { describe, expect, it } from "vitest";
import { repairStructuredOutputText } from "./structured-output-repair";

// The AI SDK only calls the repair hook after a parse/validation failure and
// passes that error along; nothing in the hook reads it.
const error = new Error("unparsable") as Parameters<
  typeof repairStructuredOutputText
>[0]["error"];

const repair = (text: string) => repairStructuredOutputText({ text, error });

describe("repairStructuredOutputText", () => {
  it("recovers the object from a fenced code block", async () => {
    await expect(
      repair(
        'Here are the scores:\n\n```json\n{"scores": [{"index": 0}]}\n```',
      ),
    ).resolves.toBe('{"scores": [{"index": 0}]}');
  });

  it("recovers the object after an inline <think> block", async () => {
    await expect(
      repair(
        '<think>\nThe passage matches the query.\n</think>\n\n{"scores":[{"index":0,"score":9}]}',
      ),
    ).resolves.toBe('{"scores":[{"index":0,"score":9}]}');
  });

  it("recovers the object from reasoning plus a fence plus trailing prose", async () => {
    await expect(
      repair(
        "<think>scoring...</think>\nHere you go:\n```json\n" +
          '{"scores": [{"index": 0, "score": 9}]}\n```\nLet me know if you need more.',
      ),
    ).resolves.toBe('{"scores": [{"index": 0, "score": 9}]}');
  });

  it("treats a stray closing tag as the end of prefilled reasoning", async () => {
    // Chat templates that prefill the opening `<think>` leave replies with only
    // the closer.
    await expect(
      repair('weighing the passage</think>{"scores":[]}'),
    ).resolves.toBe('{"scores":[]}');
  });

  it("skips prose braces that precede the real object", async () => {
    await expect(
      repair('Scored {passage 0} as follows: {"scores":[{"index":0}]}'),
    ).resolves.toBe('{"scores":[{"index":0}]}');
  });

  it("recovers a top-level array", async () => {
    await expect(repair('```\n[{"index":0}]\n```')).resolves.toBe(
      '[{"index":0}]',
    );
  });

  it("does not cut the object short on a bracket inside a string", async () => {
    await expect(repair('note:\n{"a":"}","b":1}')).resolves.toBe(
      '{"a":"}","b":1}',
    );
  });

  it("returns null for text that was already the bare object", async () => {
    // Nothing to repair — re-parsing it would fail identically, so the original
    // error (which carries the raw text) must stand.
    await expect(repair('  {"scores":[]}  ')).resolves.toBeNull();
  });

  it("returns null when the reply contains no JSON at all", async () => {
    await expect(
      repair("I cannot score these passages without more context."),
    ).resolves.toBeNull();
  });

  it("returns null when the object is truncated", async () => {
    await expect(repair('```json\n{"scores":[{"index":0,')).resolves.toBeNull();
  });

  it("returns null when the reply is nothing but reasoning", async () => {
    await expect(repair("<think>still thinking</think>")).resolves.toBeNull();
  });
});
