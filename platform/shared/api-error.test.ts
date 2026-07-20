import { describe, expect, test } from "vitest";
import { getUserFacingApiErrorMessage } from "./api-error";

describe("getUserFacingApiErrorMessage", () => {
  test("returns a descriptive server message unchanged", () => {
    const message =
      "You don't have permission to upload project files. Missing permission: file:manage (List, read, write, and delete files in chats and projects).";
    expect(
      getUserFacingApiErrorMessage({
        error: { message, type: "api_authorization_error" },
      }),
    ).toBe(message);
  });

  test("replaces a bare 'Forbidden' with readable authorization copy", () => {
    expect(
      getUserFacingApiErrorMessage({
        error: { message: "Forbidden", type: "api_authorization_error" },
      }),
    ).toBe(
      "You don't have permission to perform this action. Contact your administrator if you need access.",
    );
  });

  test("infers the category from the bare token when type is absent", () => {
    expect(getUserFacingApiErrorMessage(new Error("Forbidden"))).toBe(
      "You don't have permission to perform this action. Contact your administrator if you need access.",
    );
    expect(getUserFacingApiErrorMessage("Unauthorized")).toBe(
      "You need to sign in to perform this action.",
    );
  });

  test("unwraps the SDK's double error nesting", () => {
    // The generated SDK returns { error: <parsed body> } where the body is
    // { error: { message, type } } — two layers before the message.
    expect(
      getUserFacingApiErrorMessage({
        error: {
          error: { message: "Agent not found", type: "api_not_found_error" },
        },
      }),
    ).toBe("Agent not found");
  });

  test("maps a raw token by its type when the token itself is unknown", () => {
    expect(
      getUserFacingApiErrorMessage({
        error: { message: "Not Found", type: "api_not_found_error" },
      }),
    ).toBe("The requested resource could not be found.");
  });

  test("falls back for empty and unrecognized errors", () => {
    expect(getUserFacingApiErrorMessage(undefined, "fallback")).toBe(
      "fallback",
    );
    expect(getUserFacingApiErrorMessage({}, "fallback")).toBe("fallback");
    expect(getUserFacingApiErrorMessage("   ", "fallback")).toBe("fallback");
    expect(getUserFacingApiErrorMessage(null)).toBe(
      "Something went wrong. Please try again.",
    );
  });

  test("passes plain strings and Error messages through", () => {
    expect(getUserFacingApiErrorMessage("Upload too big")).toBe(
      "Upload too big",
    );
    expect(getUserFacingApiErrorMessage(new Error("boom"))).toBe("boom");
  });
});
