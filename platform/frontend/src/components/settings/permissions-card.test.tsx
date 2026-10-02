import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionsCard } from "@/components/settings/permissions-card";
import { useAllPermissions } from "@/lib/auth/auth.query";

vi.mock("@/lib/auth/auth.query");

function mockPermissions(permissions: Record<string, string[]> | null) {
  vi.mocked(useAllPermissions).mockReturnValue({
    data: permissions,
    isLoading: false,
  } as unknown as ReturnType<typeof useAllPermissions>);
}

describe("PermissionsCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPermissions({ agent: ["create", "read"], mcpGateway: ["read"] });
  });
  it("explains permission sources and immediately shows a useful category", () => {
    renderCard();
    expect(
      screen.getByText(
        "Permissions from your direct roles and team memberships. Focus a permission to see its source.",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Agents Read granted" }),
    ).toBeVisible();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
  it("says so when the role grants nothing", () => {
    mockPermissions({});
    renderCard();
    expect(
      screen.getByText(/Your roles and teams do not provide access/),
    ).toBeVisible();
    expect(
      screen.queryByLabelText("Filter permissions"),
    ).not.toBeInTheDocument();
  });
  it("switches categories without expanding a long list", () => {
    renderCard();
    expect(
      screen.queryByRole("group", {
        name: "MCP Gateways actions",
      }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "MCP" }));
    expect(
      screen.getByRole("button", {
        name: "MCP Gateways Read granted",
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole("group", { name: "Agents actions" }),
    ).not.toBeInTheDocument();
  });
  it("reports a failed permission lookup instead of showing empty access", () => {
    const refetch = vi.fn();
    vi.mocked(useAllPermissions).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch,
    } as unknown as ReturnType<typeof useAllPermissions>);
    renderCard();
    expect(screen.getByText("Couldn't load your permissions")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalled();
    expect(
      screen.queryByText(/Your roles and teams do not provide access/),
    ).not.toBeInTheDocument();
  });
});

function renderCard() {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity } },
  });
  client.setQueryData(
    ["auth", "permissionSources"],
    [
      {
        role: "admin",
        team: null,
        permissions: { agent: ["create", "read"], mcpGateway: ["read"] },
      },
    ],
  );
  return render(
    <QueryClientProvider client={client}>
      <PermissionsCard />
    </QueryClientProvider>,
  );
}
