import { describe, expect, it } from "vitest";
import {
  guardrailCallHeader,
  hasInternalCall,
  internalCallHeader,
  takeInternalCall,
} from "./internal-call";

describe("internal call proofs", () => {
  it("an in-process proof is not a guardrail proof", () => {
    const headers = { ...internalCallHeader() };

    expect(takeInternalCall(headers)).toEqual({
      inProcess: true,
      guardrail: false,
    });
  });

  it("a guardrail proof is not an in-process proof", () => {
    const headers = { ...guardrailCallHeader() };

    expect(takeInternalCall(headers)).toEqual({
      inProcess: false,
      guardrail: true,
    });
  });

  it("takes both proofs off the headers so they never reach the provider", () => {
    const headers: Record<string, string> = {
      ...internalCallHeader(),
      ...guardrailCallHeader(),
    };

    takeInternalCall(headers);

    expect(hasInternalCall(headers)).toBe(false);
    expect(
      Object.keys(headers).some((name) => name.startsWith("x-archestra-")),
    ).toBe(false);
  });

  it("rejects a forged value under either header name", () => {
    const headers = {
      "x-archestra-internal-call": "forged",
      "x-archestra-guardrail-call": "forged",
    };

    expect(takeInternalCall(headers)).toEqual({
      inProcess: false,
      guardrail: false,
    });
  });
});
