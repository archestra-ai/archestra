import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockToastError } = vi.hoisted(() => ({ mockToastError: vi.fn() }));

vi.mock("sonner", () => ({
  toast: { error: mockToastError, success: vi.fn() },
}));

import { getApiErrorType, throwOnApiError, toApiError } from "./api";

describe("throwOnApiError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing when there is no error", () => {
    expect(() => throwOnApiError(null)).not.toThrow();
    expect(() => throwOnApiError(undefined)).not.toThrow();
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("throws and toasts on a real error by default", () => {
    expect(() => throwOnApiError({ message: "boom" })).toThrow();
    expect(mockToastError).toHaveBeenCalledTimes(1);
  });

  it("throws without toasting when toastOnError is false", () => {
    expect(() =>
      throwOnApiError({ message: "boom" }, { toastOnError: false }),
    ).toThrow();
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("treats a not-found as a non-error when allowNotFound is set", () => {
    expect(() =>
      throwOnApiError(
        { error: { type: "api_not_found_error" } },
        { allowNotFound: true },
      ),
    ).not.toThrow();
    expect(mockToastError).not.toHaveBeenCalled();
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

describe("toApiError", () => {
  it("preserves the backend error type and message so callers can branch on it", () => {
    // A 504 timeout envelope from the backend.
    const envelope = {
      error: {
        message: "This request took too long to complete and was cancelled.",
        type: "api_timeout_error",
      },
    };

    const apiError = toApiError(envelope);

    expect(apiError).toBeInstanceOf(Error);
    expect(apiError.message).toBe(
      "This request took too long to complete and was cancelled.",
    );
    // The type must survive onto the thrown Error — otherwise a timeout is
    // indistinguishable from a network failure in the UI.
    expect(getApiErrorType(apiError)).toBe("api_timeout_error");
  });

  it("leaves a network/unknown error without a type", () => {
    const networkError = new TypeError("Failed to fetch");
    const apiError = toApiError(networkError);

    expect(apiError).toBe(networkError);
    expect(getApiErrorType(apiError)).toBeUndefined();
  });
});
