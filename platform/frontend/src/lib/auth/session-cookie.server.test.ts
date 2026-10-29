import { describe, expect, it } from "vitest";
import { hasSessionCookie } from "./session-cookie.server";

const jar = (...names: string[]) => ({
  has: (name: string) => names.includes(name),
});

describe("hasSessionCookie", () => {
  it("recognises the plain and the __Secure- session cookie", () => {
    expect(hasSessionCookie(jar("archestra.session_token"), "archestra")).toBe(
      true,
    );
    expect(
      hasSessionCookie(jar("__Secure-archestra.session_token"), "archestra"),
    ).toBe(true);
  });

  it("follows the configured prefix", () => {
    expect(hasSessionCookie(jar("dev2.session_token"), "dev2")).toBe(true);
    expect(hasSessionCookie(jar("archestra.session_token"), "dev2")).toBe(
      false,
    );
  });

  it("ignores other auth cookies", () => {
    expect(
      hasSessionCookie(
        jar("archestra.two_factor", "archestra.session_data"),
        "archestra",
      ),
    ).toBe(false);
  });
});
