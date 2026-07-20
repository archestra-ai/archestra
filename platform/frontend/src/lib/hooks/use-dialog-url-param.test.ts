"use client";

import { act, renderHook } from "@testing-library/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useDialogFlagUrlParam,
  useDialogUrlParam,
} from "./use-dialog-url-param";

vi.mock("next/navigation");

const mockReplace = vi.fn();

type TestEntity = { id: string; name: string };

const entityA: TestEntity = { id: "entity-a", name: "Entity A" };

function setSearchParams(query: string) {
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(query) as unknown as ReturnType<typeof useSearchParams>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(usePathname).mockReturnValue("/connectors");
  vi.mocked(useRouter).mockReturnValue({
    replace: mockReplace,
  } as unknown as ReturnType<typeof useRouter>);
  setSearchParams("");
});

describe("useDialogUrlParam", () => {
  it("open() sets the entity and writes the id param, preserving other params", () => {
    setSearchParams("page=2");

    const { result } = renderHook(() =>
      useDialogUrlParam<TestEntity>({ paramName: "edit", entityFromUrl: null }),
    );

    act(() => {
      result.current.open(entityA);
    });

    expect(result.current.entity).toEqual(entityA);
    expect(result.current.openedFromUrl).toBe(false);
    expect(mockReplace).toHaveBeenCalledWith(
      "/connectors?page=2&edit=entity-a",
      { scroll: false },
    );
  });

  it("close() clears the entity and removes only the id param", () => {
    setSearchParams("edit=entity-a&page=2");

    const { result } = renderHook(() =>
      useDialogUrlParam({ paramName: "edit", entityFromUrl: entityA }),
    );

    act(() => {
      result.current.close();
    });

    expect(result.current.entity).toBeNull();
    expect(mockReplace).toHaveBeenCalledWith("/connectors?page=2", {
      scroll: false,
    });
  });

  it("removing the last param replaces with the bare pathname", () => {
    setSearchParams("view=entity-a");

    const { result } = renderHook(() =>
      useDialogUrlParam({ paramName: "view", entityFromUrl: entityA }),
    );

    act(() => {
      result.current.close();
    });

    expect(mockReplace).toHaveBeenCalledWith("/connectors", { scroll: false });
  });

  it("auto-opens from a URL param once the entity loads, without rewriting the URL", () => {
    setSearchParams("edit=entity-a");

    const { result } = renderHook(() =>
      useDialogUrlParam({ paramName: "edit", entityFromUrl: entityA }),
    );

    expect(result.current.entity).toEqual(entityA);
    expect(result.current.openedFromUrl).toBe(true);
    expect(result.current.idFromUrl).toBe("entity-a");
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("keeps open/close identities stable across search-param changes and reads fresh params at call time", () => {
    setSearchParams("page=1");

    const { result, rerender } = renderHook(() =>
      useDialogUrlParam<TestEntity>({ paramName: "edit", entityFromUrl: null }),
    );

    const { open, close } = result.current;

    setSearchParams("page=2");
    rerender();

    expect(result.current.open).toBe(open);
    expect(result.current.close).toBe(close);

    act(() => {
      result.current.open(entityA);
    });

    expect(mockReplace).toHaveBeenCalledWith(
      "/connectors?page=2&edit=entity-a",
      { scroll: false },
    );
  });

  it("close() also removes the alsoClearOnClose companion params", () => {
    setSearchParams("edit=entity-a&tab=general&step=2&page=2");

    const { result } = renderHook(() =>
      useDialogUrlParam({
        paramName: "edit",
        entityFromUrl: entityA,
        alsoClearOnClose: ["tab", "step"],
      }),
    );

    act(() => {
      result.current.close();
    });

    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith("/connectors?page=2", {
      scroll: false,
    });
  });

  it("does not open while the fetched entity does not match the URL id", () => {
    setSearchParams("edit=entity-b");

    const { result } = renderHook(() =>
      useDialogUrlParam({ paramName: "edit", entityFromUrl: entityA }),
    );

    expect(result.current.entity).toBeNull();
  });

  it("stays closed when the URL has no param", () => {
    const { result } = renderHook(() =>
      useDialogUrlParam({ paramName: "edit", entityFromUrl: entityA }),
    );

    expect(result.current.entity).toBeNull();
  });
});

describe("useDialogFlagUrlParam", () => {
  it("auto-opens when the param is present, bare or with a value", () => {
    setSearchParams("edit");

    const bare = renderHook(() => useDialogFlagUrlParam("edit"));

    expect(bare.result.current.open).toBe(true);
    expect(bare.result.current.openedFromUrl).toBe(true);

    setSearchParams("edit=1");

    const valued = renderHook(() => useDialogFlagUrlParam("edit"));

    expect(valued.result.current.open).toBe(true);
    expect(valued.result.current.openedFromUrl).toBe(true);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("setOpen(true) writes the bare param, preserving other params", () => {
    setSearchParams("page=2");

    const { result } = renderHook(() => useDialogFlagUrlParam("edit"));

    act(() => {
      result.current.setOpen(true);
    });

    expect(result.current.open).toBe(true);
    expect(result.current.openedFromUrl).toBe(false);
    expect(mockReplace).toHaveBeenCalledWith("/connectors?page=2&edit", {
      scroll: false,
    });
    expect(vi.mocked(mockReplace).mock.calls[0][0]).not.toContain("edit=");
  });

  it("setOpen(false) removes only the flag param", () => {
    setSearchParams("edit&page=2");

    const { result } = renderHook(() => useDialogFlagUrlParam("edit"));

    act(() => {
      result.current.setOpen(false);
    });

    expect(result.current.open).toBe(false);
    expect(mockReplace).toHaveBeenCalledWith("/connectors?page=2", {
      scroll: false,
    });
  });

  it("does not reopen from the stale param right after setOpen(false)", () => {
    setSearchParams("edit");

    const { result, rerender } = renderHook(() =>
      useDialogFlagUrlParam("edit"),
    );

    expect(result.current.open).toBe(true);

    act(() => {
      result.current.setOpen(false);
    });
    rerender();

    expect(result.current.open).toBe(false);
  });

  it("keeps setOpen identity stable across search-param changes and reads fresh params at call time", () => {
    setSearchParams("page=1");

    const { result, rerender } = renderHook(() =>
      useDialogFlagUrlParam("edit"),
    );

    const { setOpen } = result.current;

    setSearchParams("page=2");
    rerender();

    expect(result.current.setOpen).toBe(setOpen);

    act(() => {
      result.current.setOpen(true);
    });

    expect(mockReplace).toHaveBeenCalledWith("/connectors?page=2&edit", {
      scroll: false,
    });
  });

  it("stays closed when the URL has no param", () => {
    const { result } = renderHook(() => useDialogFlagUrlParam("edit"));

    expect(result.current.open).toBe(false);
    expect(result.current.openedFromUrl).toBe(false);
  });
});
