import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner");

import { throwOnApiError } from "./api";

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
