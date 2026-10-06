import { describe, expect, test } from "vitest";
import { copyOwnRecord, markOmitted, omissionStubs } from "./provenance";
import {
  captureRewriteRequest,
  RewriteProjectionError,
} from "./rewrite-projection";

const origin = Symbol("origin");

describe("rewrite provenance", () => {
  test("copies the exact origin symbol onto a source-derived replacement", () => {
    const source = { text: "kept" };
    Object.defineProperty(source, origin, {
      value: { v: 1, id: 4 },
      enumerable: true,
    });
    const replacement = copyOwnRecord(source, [["text", "kept"]]);
    expect(replacement[origin]).toEqual({ v: 1, id: 4 });
    expect(copyOwnRecord(source, [["injected", true]])[origin]).toEqual({
      v: 1,
      id: 4,
    });
  });

  test("does not let a __proto__ key set the prototype of a restored record", () => {
    const copied = copyOwnRecord({}, [
      ["__proto__", { polluted: true }],
      ["safe", 1],
    ]);
    expect(Object.getPrototypeOf(copied)).toBe(Object.prototype);
    expect(Object.hasOwn(copied, "__proto__")).toBe(true);
    expect(copied.safe).toBe(1);
    expect(copied.polluted).toBeUndefined();
  });

  test("replacing a captured text holder without its origin is lost-source", () => {
    const body = {
      model: "m",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    };
    const capture = captureRewriteRequest(body, "anthropic:messages");
    body.messages[0].content[0] = { type: "text", text: "hello" };
    expect(() =>
      capture.project(body, new Map(), { allowInitial: true }),
    ).toThrow(RewriteProjectionError);
    try {
      capture.project(body, new Map(), { allowInitial: true });
    } catch (error) {
      expect(error).toBeInstanceOf(RewriteProjectionError);
      expect((error as RewriteProjectionError).code).toBe("lost-source");
    }
  });

  test("an omitted captured holder is recorded and not sent", () => {
    const body = {
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "keep" },
            { type: "text", text: "   " },
          ],
        },
      ],
    };
    const capture = captureRewriteRequest(body, "anthropic:messages");
    markOmitted(body.messages[0].content[1]);
    const projected = capture.project(body, new Map(), { allowInitial: true });
    const request = projected.request as {
      messages: Array<{ content: Array<{ text?: string }> }>;
    };
    expect(request.messages[0].content.map((block) => block.text)).toEqual([
      "keep",
    ]);
    expect(JSON.stringify(request)).not.toContain("   ");
  });

  test("a canonical stub keeps provenance and not the withheld payload", () => {
    const source = {
      status: { completed: "secret child report" },
      content: [{ type: "text", text: "secret child report" }],
    };
    Object.defineProperty(source.content[0], Symbol("openappa.rewriteOrigin"), {
      value: { v: 1, id: 9 },
      enumerable: true,
    });
    const stubs = omissionStubs(source);
    expect(stubs).toHaveLength(1);
    expect(JSON.stringify(stubs[0])).toBe("{}");
    expect(
      Object.getOwnPropertySymbols(stubs[0]).some(
        (symbol) => symbol.description === "openappa.rewriteOrigin",
      ),
    ).toBe(true);
    expect(JSON.stringify(stubs)).not.toContain("secret");
  });

  test("a captured text holder still projects after its text is edited in place", () => {
    const body = {
      model: "m",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "   " }],
        },
      ],
    };
    const capture = captureRewriteRequest(body, "anthropic:messages");
    const block = body.messages[0].content[0];
    block.text = " ";
    expect(() =>
      capture.project(body, new Map(), { allowInitial: true }),
    ).not.toThrow();
  });
});
