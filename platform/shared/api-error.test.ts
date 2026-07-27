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

  test("never surfaces an HTML error page; maps its status line instead", () => {
    // What a proxy/ingress in front of the API returns on a bad gateway —
    // reaches the client verbatim because it isn't the JSON envelope.
    const nginx502 =
      "<html> <head><title>502 Bad Gateway</title></head> <body> <center><h1>502 Bad Gateway</h1></center> </body> </html> <!-- a padding to disable MSIE and Chrome friendly error page -->";
    const unavailable =
      "The service is temporarily unavailable. Please try again shortly.";

    expect(getUserFacingApiErrorMessage(nginx502)).toBe(unavailable);
    expect(getUserFacingApiErrorMessage(new Error(nginx502))).toBe(unavailable);
    expect(
      getUserFacingApiErrorMessage(
        "<html><head><title>504 Gateway Time-out</title></head><body></body></html>",
      ),
    ).toBe(unavailable);
    expect(
      getUserFacingApiErrorMessage(
        "<!DOCTYPE html><html><head><title>Maintenance</title></head><body>Down for maintenance</body></html>",
        "fallback",
      ),
    ).toBe("fallback");
    expect(getUserFacingApiErrorMessage("<html><body></body></html>")).toBe(
      "Something went wrong. Please try again.",
    );
  });

  test("humanizes plain-text gateway status lines, with or without the code", () => {
    const unavailable =
      "The service is temporarily unavailable. Please try again shortly.";
    expect(getUserFacingApiErrorMessage("502 Bad Gateway")).toBe(unavailable);
    expect(getUserFacingApiErrorMessage("Bad Gateway")).toBe(unavailable);
    expect(getUserFacingApiErrorMessage("503 Service Unavailable")).toBe(
      unavailable,
    );
  });
});
