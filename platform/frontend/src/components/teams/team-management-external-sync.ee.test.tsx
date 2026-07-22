import type { archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { TeamManagementExternalSyncSection } from "./team-management-external-sync.ee";

type Team = archestraApiTypes.GetTeamsResponses["200"]["data"][number];

const { useIdentityProvidersMock } = vi.hoisted(() => ({
  useIdentityProvidersMock: vi.fn(),
}));

vi.mock("@/lib/auth/auth.query");

vi.mock("@/lib/auth/identity-provider.query.ee", () => ({
  useIdentityProviderLatestIdTokenClaims: vi.fn(() => ({ data: null })),
  useIdentityProviders: useIdentityProvidersMock,
}));

vi.mock("@/lib/hooks/use-app-name");

describe("TeamManagementExternalSyncSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAppName).mockReturnValue("Test App");
    useIdentityProvidersMock.mockReturnValue({ data: [] });
  });

  it("links users with identityProvider:create to identity provider setup", () => {
    vi.mocked(useHasPermissions).mockImplementation(
      (permissions) =>
        ({
          data: permissions.identityProvider?.includes("create") ?? false,
        }) as ReturnType<typeof useHasPermissions>,
    );

    renderSection();

    expect(
      screen.getByRole("link", { name: "Add an identity provider" }),
    ).toHaveAttribute("href", "/settings/identity-providers");
    expect(
      screen.getByText(/before configuring external group sync/i),
    ).toBeInTheDocument();
  });

  it("asks users without identityProvider:create to contact an admin", () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
    } as ReturnType<typeof useHasPermissions>);

    renderSection();

    expect(
      screen.getByText(
        "Ask your admin to add an identity provider before configuring external group sync.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Add an identity provider" }),
    ).not.toBeInTheDocument();
  });
});

function renderSection() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <TeamManagementExternalSyncSection open={false} team={makeTeam()} />
    </QueryClientProvider>,
  );
}

function makeTeam(): Team {
  return {
    id: "team-a",
    name: "Team A",
    description: null,
    organizationId: "org-1",
    createdBy: "user-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    convertToolResultsToToon: false,
    members: [],
  };
}
