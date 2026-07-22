import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner");

import { getApiErrorMessage, handleApiError, throwOnApiError } from "./api";

describe("throwOnApiError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing when there is no error", () => {
    expect(() => throwOnApiError(null)).not.toThrow();
    expect(() => throwOnApiError(undefined)).not.toThrow();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("throws and toasts on a real error by default", () => {
    expect(() => throwOnApiError({ message: "boom" })).toThrow();
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it("throws without toasting when toastOnError is false", () => {
    expect(() =>
      throwOnApiError({ message: "boom" }, { toastOnError: false }),
    ).toThrow();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("treats a not-found as a non-error when allowNotFound is set", () => {
    expect(() =>
      throwOnApiError(
        { error: { type: "api_not_found_error" } },
        { allowNotFound: true },
      ),
    ).not.toThrow();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("still throws on a not-found when allowNotFound is not set", () => {
    expect(() =>
      throwOnApiError({ error: { type: "api_not_found_error" } }),
    ).toThrow();
  });

  it("still throws on non-not-found errors even when allowNotFound is set", () => {
    expect(() =>
      throwOnApiError(
        { error: { type: "api_internal_error" } },
        { allowNotFound: true, toastOnError: false },
      ),
    ).toThrow();
  });
});

describe("handleApiError toast dedupe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keys the toast by its message so repeated identical errors collapse", () => {
    const error = {
      error: {
        message: "You don't have permission to get schedule triggers.",
        type: "api_authorization_error",
      },
    };

    handleApiError(error);
    handleApiError(error);

    expect(toast.error).toHaveBeenCalledTimes(2);
    const [firstMessage, firstOptions] = vi.mocked(toast.error).mock.calls[0];
    const [secondMessage, secondOptions] = vi.mocked(toast.error).mock.calls[1];
    expect(firstOptions?.id).toBe(firstMessage);
    expect(secondOptions?.id).toBe(secondMessage);
    expect(firstOptions?.id).toBe(secondOptions?.id);
  });

  it("keeps distinct messages as distinct toasts", () => {
    handleApiError({ error: { message: "first failure" } });
    handleApiError({ error: { message: "second failure" } });

    const ids = vi
      .mocked(toast.error)
      .mock.calls.map(([, options]) => options?.id);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("getApiErrorMessage", () => {
  it("returns the server's descriptive message unchanged", () => {
    expect(
      getApiErrorMessage({
        error: {
          error: {
            message: "You don't have permission to upload project files.",
            type: "api_authorization_error",
          },
        },
      }),
    ).toBe("You don't have permission to upload project files.");
  });

  it("never surfaces a bare 'Forbidden' — humanizes it instead", () => {
    expect(
      getApiErrorMessage({
        error: {
          error: { message: "Forbidden", type: "api_authorization_error" },
        },
      }),
    ).toBe(
      "You don't have permission to perform this action. Contact your administrator if you need access.",
    );
  });

  it("falls back to the generic API message for empty errors", () => {
    expect(getApiErrorMessage({})).toBe("API request failed");
  });
});
