import { render, screen } from "@testing-library/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import McpCatalogLayout from "./layout";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");

describe("McpCatalogLayout", () => {
  const replace = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usePathname).mockReturnValue("/mcp/registry");
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
      replace,
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
    } as ReturnType<typeof useHasPermissions>);
  });

  it("renders one registry list without audience tabs", () => {
    render(
      <McpCatalogLayout>
        <div>Registry content</div>
      </McpCatalogLayout>,
    );

    expect(screen.getByText("Registry content")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /Action required/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("mcp-registry-action-required-tab"),
    ).not.toBeInTheDocument();
  });

  it("redirects retired attention-tab links to the attention filter", () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("tab=attention") as ReturnType<
        typeof useSearchParams
      >,
    );

    render(
      <McpCatalogLayout>
        <div>Registry content</div>
      </McpCatalogLayout>,
    );

    expect(replace).toHaveBeenCalledWith(
      "/mcp/registry?status=needs-my-action",
      { scroll: false },
    );
  });

  it("leaves nested registry pages to render their own shared header", () => {
    vi.mocked(usePathname).mockReturnValue("/mcp/registry/new");

    render(
      <McpCatalogLayout>
        <h1>Add MCP Server to the Private Registry</h1>
      </McpCatalogLayout>,
    );

    expect(
      screen.getByRole("heading", {
        name: "Add MCP Server to the Private Registry",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "MCP Registry" }),
    ).not.toBeInTheDocument();
  });
});
