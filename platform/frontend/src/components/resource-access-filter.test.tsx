import { render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  ResourceAccessFilter,
  useResourceAccessParam,
} from "./resource-access-filter";
import { useScopeFilterParams } from "./resource-scope-filter";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/agent.query", () => ({
  useLabelKeys: () => ({ data: [] }),
  useLabelValues: () => ({ data: [] }),
}));

const push = vi.fn();
function setQuery(query: string) {
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(query) as ReturnType<typeof useSearchParams>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useRouter).mockReturnValue({ push } as unknown as ReturnType<
    typeof useRouter
  >);
  vi.mocked(usePathname).mockReturnValue("/agents");
  setQuery("");
  setReadsEveryObject(true);
});

function setReadsEveryObject(value: boolean) {
  vi.mocked(useHasPermissions).mockReturnValue({
    data: value,
  } as ReturnType<typeof useHasPermissions>);
}

describe("resource access filter", () => {
  it("hides other people's objects until the viewer asks for them", () => {
    const { result } = renderHook(() => useResourceAccessParam());
    expect(result.current).toEqual({
      access: ["mine", "shared", "org"],
      isDefault: true,
    });
  });

  it("reads a bookmarked selection and counts it as an active filter", () => {
    setQuery("access=others,mine");
    expect(renderHook(() => useScopeFilterParams()).result.current).toEqual(
      expect.objectContaining({
        access: ["mine", "others"],
        hasActiveScopeFilters: true,
      }),
    );
  });

  it("falls back to the default when the parameter holds nothing usable", () => {
    setQuery("access=bogus");
    expect(renderHook(() => useResourceAccessParam()).result.current).toEqual({
      access: ["mine", "shared", "org"],
      isDefault: true,
    });
  });

  it("adds others to the URL and resets the page", async () => {
    setQuery("page=3&name=x");
    render(<ResourceAccessFilter resource="agent" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Filter by access" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: /Others/ }));
    expect(push).toHaveBeenCalledWith(
      "/agents?name=x&access=mine%2Cshared%2Corg%2Cothers",
      { scroll: false },
    );
  });

  it("drops the parameter when the selection returns to the default", async () => {
    setQuery("access=mine,shared,org,others");
    render(<ResourceAccessFilter resource="agent" />);
    expect(
      screen.getByRole("button", { name: "Filter by access" }),
    ).toHaveTextContent("All");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Filter by access" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: /Others/ }));
    expect(push).toHaveBeenCalledWith("/agents?", { scroll: false });
  });

  it("offers others only to a viewer who reads every object of the type", async () => {
    setReadsEveryObject(false);
    render(<ResourceAccessFilter resource="agent" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Filter by access" }));
    expect(screen.getAllByRole("menuitemcheckbox")).toHaveLength(3);
    expect(
      screen.queryByRole("menuitemcheckbox", { name: /Others/ }),
    ).not.toBeInTheDocument();
    expect(useHasPermissions).toHaveBeenCalledWith({ agent: ["read"] }, "*");
  });

  it("keeps a bookmarked others selection clearable without that access", async () => {
    setReadsEveryObject(false);
    setQuery("access=mine,others");
    render(<ResourceAccessFilter resource="agent" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Filter by access" }));
    expect(
      screen.getByRole("menuitemcheckbox", { name: /Others/ }),
    ).toBeInTheDocument();
  });

  it("keeps the last remaining relation selected", async () => {
    setQuery("access=mine");
    render(<ResourceAccessFilter resource="agent" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Filter by access" }));
    expect(
      screen.getByRole("menuitemcheckbox", { name: /^Mine/ }),
    ).toHaveAttribute("aria-disabled", "true");
  });
});
