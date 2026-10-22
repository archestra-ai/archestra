import { describe, expect, it } from "vitest";
import {
  guardrailCallHeader,
  internalCallHeader,
  internalCallProvenance,
} from "./internal-call";

function takeInternalCall(
  headers: Record<string, string | string[] | undefined>,
) {
  return internalCallProvenance({ headers });
}

describe("internal call proofs", () => {
  it("retains separate proof purposes after schema processing and strips every header view", () => {
    const headers = { ...guardrailCallHeader(), host: "localhost" };
    const raw = {
      headers: { ...headers },
      rawHeaders: Object.entries(headers).flat(),
    };
    expect(internalCallProvenance({ headers, raw })).toEqual({
      inProcess: false,
      guardrail: true,
    });
    expect(headers).toEqual({ host: "localhost" });
    expect(raw.headers).toEqual({ host: "localhost" });
    expect(raw.rawHeaders).toEqual(["host", "localhost"]);
    expect(internalCallProvenance({ headers: {}, raw })).toEqual({
      inProcess: false,
      guardrail: true,
    });
  });

  it("cannot upgrade an untrusted request with a later proof", () => {
    const request = {
      headers: {} as Record<string, string>,
      raw: {
        headers: {} as Record<string, string>,
        rawHeaders: [] as string[],
      },
    };
    expect(internalCallProvenance(request).inProcess).toBe(false);
    Object.assign(request.headers, internalCallHeader());
    Object.assign(request.raw.headers, guardrailCallHeader());
    request.raw.rawHeaders.push(
      ...Object.entries({
        ...internalCallHeader(),
        ...guardrailCallHeader(),
      }).flat(),
    );
    expect(internalCallProvenance(request)).toEqual({
      inProcess: false,
      guardrail: false,
    });
    expect(request.headers).toEqual({});
    expect(request.raw.headers).toEqual({});
    expect(request.raw.rawHeaders).toEqual([]);
  });

  it.each([
    "=",
    ", #",
    "\n",
    " ",
  ])("rejects a valid proof with suffix %j", (suffix) => {
    for (const header of [internalCallHeader(), guardrailCallHeader()]) {
      const [[name, value]] = Object.entries(header);
      expect(takeInternalCall({ [name]: value + suffix })).toEqual({
        inProcess: false,
        guardrail: false,
      });
    }
  });

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
