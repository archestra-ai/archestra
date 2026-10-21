import { describe, expect, test } from "vitest";
import { internalCallHeader, isInternalCall } from "./internal-call";

describe("isInternalCall", () => {
  test("accepts this process's proof and removes it from both header sets", () => {
    const raw = {
      headers: { ...internalCallHeader(), host: "x" },
      rawHeaders: [
        "X-Archestra-Internal-Call",
        internalCallHeader()["x-archestra-internal-call"],
        "Host",
        "x",
      ],
    };
    const request = { headers: { ...raw.headers }, raw };

    expect(isInternalCall(request)).toBe(true);
    expect(request.headers).toEqual({ host: "x" });
    expect(raw.headers).toEqual({ host: "x" });
    expect(raw.rawHeaders).toEqual(["Host", "x"]);
  });

  test("keeps the first answer for the same request", () => {
    const raw = { headers: internalCallHeader() };
    expect(isInternalCall({ headers: raw.headers, raw })).toBe(true);
    // A later reader sees a fresh (e.g. schema-validated) headers object for
    // the same underlying request, with the proof already gone.
    expect(isInternalCall({ headers: {}, raw })).toBe(true);
  });

  test.each<[string, Record<string, string | string[]>]>([
    ["missing", {}],
    ["forged", { "x-archestra-internal-call": "A".repeat(43) }],
    ["truncated", { "x-archestra-internal-call": "abc" }],
    ...["=", ", #", "\n", " "].map<[string, Record<string, string>]>(
      (suffix) => [
        `noncanonical suffix ${JSON.stringify(suffix)}`,
        {
          "x-archestra-internal-call":
            internalCallHeader()["x-archestra-internal-call"] + suffix,
        },
      ],
    ),
    [
      "duplicated",
      {
        "x-archestra-internal-call": `${internalCallHeader()["x-archestra-internal-call"]}, ${internalCallHeader()["x-archestra-internal-call"]}`,
      },
    ],
    [
      "repeated as an array",
      {
        "x-archestra-internal-call": [
          internalCallHeader()["x-archestra-internal-call"],
        ],
      },
    ],
  ])("rejects a %s proof and still strips it", (_label, headers) => {
    const raw = {
      headers: { ...headers } as Record<string, string | string[]>,
    };
    expect(isInternalCall({ headers: raw.headers, raw })).toBe(false);
    expect(raw.headers).toEqual({});
  });

  test("a later header cannot upgrade an untrusted request", () => {
    const request = { headers: {} as Record<string, string> };
    expect(isInternalCall(request)).toBe(false);
    Object.assign(request.headers, internalCallHeader());
    expect(isInternalCall(request)).toBe(false);
    expect(request.headers).toEqual({});
  });
});
