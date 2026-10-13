// @vitest-environment node
import { describe, expect, it } from "vitest";
import { withoutProxyTransportArguments } from "./proxy-transport-arguments";

describe("withoutProxyTransportArguments", () => {
  it("hides the runtime proof OpenAPPA stamps on delegation calls", () => {
    expect(
      withoutProxyTransportArguments({
        toolName: "agent__self",
        shortName: null,
        input: { message: "find it", runtime_proof: "payload.mac" },
      }),
    ).toEqual({ message: "find it" });
  });

  it("leaves a non-archestra tool's same-named argument alone", () => {
    const input = { runtime_proof: "user data" };
    expect(
      withoutProxyTransportArguments({
        toolName: "github__search",
        shortName: null,
        input,
      }),
    ).toBe(input);
  });
});
