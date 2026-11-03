import type { archestraApiTypes } from "@archestra/shared";
import { archestraApiSdk } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { TeamSyncSection } from "./team-sync-section.ee";

type Team = archestraApiTypes.GetTeamResponses["200"];
type GroupLink =
  archestraApiTypes.GetTeamExternalGroupsResponses["200"][number];

const { useTeamSyncIdentityProviderOptionsMock } = vi.hoisted(() => ({
  useTeamSyncIdentityProviderOptionsMock: vi.fn(),
}));

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/auth/identity-provider.query.ee", () => ({
  useTeamSyncIdentityProviderOptions: useTeamSyncIdentityProviderOptionsMock,
}));
vi.mock("@archestra/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@archestra/shared")>()),
  archestraApiSdk: {
    getTeamExternalGroups: vi.fn(),
    addTeamExternalGroup: vi.fn(),
    removeTeamExternalGroup: vi.fn(),
  },
}));

const okta = { id: "idp-okta", providerId: "Okta", groupsExpression: null };
const entra = { id: "idp-entra", providerId: "Entra", groupsExpression: null };

describe("TeamSyncSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
    } as ReturnType<typeof useHasPermissions>);
    useTeamSyncIdentityProviderOptionsMock.mockReturnValue({ data: [okta] });
    serveLinks([]);
    vi.mocked(archestraApiSdk.addTeamExternalGroup).mockResolvedValue({
      data: {},
      // biome-ignore lint/suspicious/noExplicitAny: partial sdk result stub
    } as any);
    vi.mocked(archestraApiSdk.removeTeamExternalGroup).mockResolvedValue({
      data: { success: true },
      // biome-ignore lint/suspicious/noExplicitAny: partial sdk result stub
    } as any);
  });

  it("explains Team Sync before anything is linked", async () => {
    renderSection();

    expect(
      screen.getByText(/Add people to Team A from their identity provider/),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: /Link a group/ }),
    ).toHaveTextContent("No groups linked yet");
  });

  it("links users with identityProvider:create to identity provider setup", () => {
    useTeamSyncIdentityProviderOptionsMock.mockReturnValue({ data: [] });
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
      screen.queryByRole("button", { name: /Link a group/ }),
    ).not.toBeInTheDocument();
  });

  it("asks users without identityProvider:create to contact an admin", () => {
    useTeamSyncIdentityProviderOptionsMock.mockReturnValue({ data: [] });

    renderSection();

    expect(
      screen.getByText(
        "Ask your admin to add an identity provider before linking groups.",
      ),
    ).toBeInTheDocument();
  });

  it("links a group from the only provider with the chosen team role", async () => {
    const user = await setupUserEvent();
    renderSection();

    await user.click(
      await screen.findByRole("button", { name: /Link a group/ }),
    );
    // One provider needs no picker.
    expect(
      screen.queryByRole("combobox", { name: "Identity provider" }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("combobox", { name: "Team role for the linked group" }),
    );
    const listbox = await screen.findByRole("listbox");
    expect(
      within(listbox).getByText(/its members and LLM limits/),
    ).toBeInTheDocument();
    await user.click(within(listbox).getByRole("option", { name: /^Admin/ }));
    await user.type(
      screen.getByRole("textbox", { name: "Group identifier" }),
      "Platform-Leads{Enter}",
    );

    await waitFor(() =>
      expect(archestraApiSdk.addTeamExternalGroup).toHaveBeenCalledWith({
        path: { id: "team-a" },
        body: {
          identityProviderId: "idp-okta",
          groupIdentifier: "Platform-Leads",
          role: "admin",
        },
      }),
    );
  });

  it("asks which provider a group comes from when there are several", async () => {
    useTeamSyncIdentityProviderOptionsMock.mockReturnValue({
      data: [okta, entra],
    });
    const user = await setupUserEvent();
    renderSection();

    await user.click(
      await screen.findByRole("button", { name: /Link a group/ }),
    );
    await user.click(
      screen.getByRole("combobox", { name: "Identity provider" }),
    );
    await user.click(await screen.findByRole("option", { name: "Entra" }));
    await user.type(
      screen.getByRole("textbox", { name: "Group identifier" }),
      "engineering",
    );
    await user.click(screen.getByRole("button", { name: "Link group" }));

    await waitFor(() =>
      expect(archestraApiSdk.addTeamExternalGroup).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            identityProviderId: "idp-entra",
            role: "member",
          }),
        }),
      ),
    );
  });

  it("lists links with their provider and role, and unlinks one", async () => {
    serveLinks([
      link({ id: "g-1", groupIdentifier: "engineering" }),
      link({
        id: "g-2",
        groupIdentifier: "platform-leads",
        identityProviderId: "idp-okta",
        role: "admin",
      }),
    ]);
    const user = await setupUserEvent();
    renderSection();

    expect(await screen.findByText("platform-leads")).toBeInTheDocument();
    expect(screen.getByText("Any provider")).toBeInTheDocument();
    expect(screen.getByText("Okta")).toBeInTheDocument();
    expect(screen.getByText("Admin")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Unlink group platform-leads" }),
    );
    await waitFor(() =>
      expect(archestraApiSdk.removeTeamExternalGroup).toHaveBeenCalledWith({
        path: { id: "team-a", groupId: "g-2" },
      }),
    );
  });

  it("cancels the new link with Escape", async () => {
    const user = await setupUserEvent();
    renderSection();

    await user.click(
      await screen.findByRole("button", { name: /Link a group/ }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "Group identifier" }),
      "ops{Escape}",
    );

    expect(
      screen.queryByRole("textbox", { name: "Group identifier" }),
    ).not.toBeInTheDocument();
    expect(archestraApiSdk.addTeamExternalGroup).not.toHaveBeenCalled();
  });

  it("lists links without link or unlink controls in read-only mode", async () => {
    serveLinks([link({ id: "g-1", groupIdentifier: "engineering" })]);

    renderSection({ readOnly: true });

    expect(await screen.findByText("engineering")).toBeInTheDocument();
    expect(
      screen.getByText(/Team admins manage these links/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Link a group/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Unlink group/ }),
    ).not.toBeInTheDocument();
  });
});

function serveLinks(links: GroupLink[]) {
  vi.mocked(archestraApiSdk.getTeamExternalGroups).mockResolvedValue({
    data: links,
    // biome-ignore lint/suspicious/noExplicitAny: partial sdk result stub
  } as any);
}

function link(overrides: Partial<GroupLink>): GroupLink {
  return {
    id: "g",
    teamId: "team-a",
    groupIdentifier: "group",
    identityProviderId: null,
    role: "member",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as GroupLink;
}

async function setupUserEvent() {
  // Radix Select relies on pointer-capture + scrollIntoView, which jsdom
  // does not implement.
  window.HTMLElement.prototype.hasPointerCapture = vi.fn();
  window.HTMLElement.prototype.setPointerCapture = vi.fn();
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  const { default: userEvent } = await import("@testing-library/user-event");
  return userEvent.setup();
}

function renderSection({ readOnly = false }: { readOnly?: boolean } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <TeamSyncSection open team={makeTeam()} readOnly={readOnly} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function makeTeam(): Team {
  return {
    id: "team-a",
    name: "Team A",
    description: null,
    organizationId: "org-1",
    parentId: null,
    createdBy: "user-1",
    createdByServiceAccountId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    roles: [],
    members: [],
  };
}
