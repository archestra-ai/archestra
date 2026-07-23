import type { archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { TeamManagementExternalSyncSection } from "./team-management-external-sync.ee";

type Team = archestraApiTypes.GetTeamsResponses["200"]["data"][number];

const { useTeamSyncIdentityProviderOptionsMock } = vi.hoisted(() => ({
  useTeamSyncIdentityProviderOptionsMock: vi.fn(),
}));

vi.mock("@/lib/auth/auth.query");

vi.mock("@/lib/auth/identity-provider.query.ee", () => ({
  useIdentityProviderLatestIdTokenClaims: vi.fn(() => ({ data: null })),
  useTeamSyncIdentityProviderOptions: useTeamSyncIdentityProviderOptionsMock,
}));

vi.mock("@/lib/hooks/use-app-name");

describe("TeamManagementExternalSyncSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAppName).mockReturnValue("Test App");
    useTeamSyncIdentityProviderOptionsMock.mockReturnValue({ data: [] });
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

  it("renders providers from the team-sync options projection with mapping controls", () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
    } as ReturnType<typeof useHasPermissions>);
    useTeamSyncIdentityProviderOptionsMock.mockReturnValue({
      data: [
        {
          id: "idp-1",
          providerId: "keycloak",
          groupsExpression: "{{#each groups}}{{this}},{{/each}}",
        },
      ],
    });

    renderSection();

    expect(screen.getByText("keycloak")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Group Extraction Template"),
    ).toHaveDisplayValue("{{#each groups}}{{this}},{{/each}}");
    expect(screen.getByText("Add External Group Mapping")).toBeInTheDocument();
  });

  it("hides the mapping controls in read-only mode", () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
    } as ReturnType<typeof useHasPermissions>);
    useTeamSyncIdentityProviderOptionsMock.mockReturnValue({
      data: [{ id: "idp-1", providerId: "keycloak", groupsExpression: null }],
    });

    renderSection({ readOnly: true });

    expect(screen.getByText("keycloak")).toBeInTheDocument();
    expect(
      screen.queryByText("Add External Group Mapping"),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
  });
});

function renderSection({ readOnly = false }: { readOnly?: boolean } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <TeamManagementExternalSyncSection
        open={false}
        team={makeTeam()}
        readOnly={readOnly}
      />
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
