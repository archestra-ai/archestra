import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useDefaultEnvironmentIdForResource } from "@/lib/environment.query";
import { useDefaultEnvironmentSeed } from "./use-default-environment-seed";

vi.mock("@/lib/environment.query", () => ({
  useDefaultEnvironmentIdForResource: vi.fn(),
}));

function setResolution(environmentId: string | null, isResolved = true) {
  vi.mocked(useDefaultEnvironmentIdForResource).mockReturnValue({
    environmentId,
    isResolved,
  });
}

describe("useDefaultEnvironmentSeed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("seeds the resolved environment once", () => {
    setResolution("env-explore");
    const apply = vi.fn();

    const { rerender } = renderHook(() =>
      useDefaultEnvironmentSeed({
        resource: "mcpRegistry",
        enabled: true,
        apply,
      }),
    );
    rerender();

    expect(apply).toHaveBeenCalledExactlyOnceWith("env-explore");
  });

  test("leaves the field alone when the resolution is the Default environment", () => {
    setResolution(null);
    const apply = vi.fn();

    renderHook(() =>
      useDefaultEnvironmentSeed({
        resource: "mcpRegistry",
        enabled: true,
        apply,
      }),
    );

    expect(apply).not.toHaveBeenCalled();
  });

  test("does not seed a disabled (edit) form", () => {
    setResolution("env-explore");
    const apply = vi.fn();

    renderHook(() =>
      useDefaultEnvironmentSeed({
        resource: "mcpRegistry",
        enabled: false,
        apply,
      }),
    );

    expect(apply).not.toHaveBeenCalled();
  });

  test("waits for a trustworthy answer instead of seeding a partial one", () => {
    setResolution(null, false);
    const apply = vi.fn();

    const { rerender } = renderHook(() =>
      useDefaultEnvironmentSeed({
        resource: "mcpRegistry",
        enabled: true,
        apply,
      }),
    );
    expect(apply).not.toHaveBeenCalled();

    setResolution("env-explore");
    rerender();

    expect(apply).toHaveBeenCalledExactlyOnceWith("env-explore");
  });

  test("seeds again the next time a reused dialog reopens", () => {
    setResolution("env-explore");
    const apply = vi.fn();

    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useDefaultEnvironmentSeed({
          resource: "mcpRegistry",
          enabled,
          apply,
        }),
      { initialProps: { enabled: true } },
    );
    expect(apply).toHaveBeenCalledTimes(1);

    rerender({ enabled: false });
    rerender({ enabled: true });

    expect(apply).toHaveBeenCalledTimes(2);
  });
});
