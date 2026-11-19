import { describe, expect, test } from "vitest";
import { parseReviewScope } from "./review-scope";

describe("parseReviewScope", () => {
  test("reads the runtime's wire shape", () => {
    const scope = [
      {
        kind: "attention",
        mark: "email-review",
        text: "attention: email-review",
      },
      {
        kind: "narrowing",
        narrowing: { type: "sign_off", tools: ["send_email"] },
        text: "later send_email calls need sign-off",
      },
    ];
    expect(parseReviewScope(JSON.stringify(scope))).toEqual(scope);
  });

  test("keeps an empty scope distinct from an unknown one", () => {
    expect(parseReviewScope("[]")).toEqual([]);
    expect(parseReviewScope(undefined)).toBeUndefined();
  });

  test("treats an item this build does not know as unknown scope, not a shorter list", () => {
    const scope = [
      { kind: "attention", mark: "a", text: "attention: a" },
      { kind: "future", text: "something new" },
    ];
    expect(parseReviewScope(JSON.stringify(scope))).toBeUndefined();
    expect(parseReviewScope("[")).toBeUndefined();
  });
});
