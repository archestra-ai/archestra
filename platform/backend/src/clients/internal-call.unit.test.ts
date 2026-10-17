import { describe, expect, it } from "vitest";
import {
  guardrailCallHeader,
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

  it("rejects each proof's value presented under the other header", () => {
    const [[inProcessHeader, inProcessValue]] = Object.entries(
      internalCallHeader(),
    );
    const [[guardrailHeader, guardrailValue]] = Object.entries(
      guardrailCallHeader(),
    );

    expect(
      takeInternalCall({
        [guardrailHeader]: inProcessValue,
        [inProcessHeader]: guardrailValue,
      }),
    ).toEqual({ inProcess: false, guardrail: false });
  });

  it("takes both proofs off the headers so they never reach the provider", () => {
    const headers: Record<string, string> = {
      ...internalCallHeader(),
      ...guardrailCallHeader(),
    };

    takeInternalCall(headers);

    expect(headers).toEqual({});
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
