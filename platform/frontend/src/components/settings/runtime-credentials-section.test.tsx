import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useSyncExternalStore } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppName } from "@/lib/hooks/use-app-name";
import { RuntimeCredentialsSection } from "./runtime-credentials-section";

global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();

const mocks = vi.hoisted(() => ({
  setActionButton: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  deleteDefinition: vi.fn(),
  disconnect: vi.fn(),
  refetch: vi.fn(),
  useRuntimeCredentialUsage: vi.fn(),
  definitions: [
    {
      key: "github",
      name: "GitHub PAT",
      description: "Access GitHub repositories",
      icon: "logo:github",
      builtIn: true,
      allowPersonal: true,
      allowOrganization: false,
      personalConfigured: false,
      organizationConfigured: false,
    },
  ],
}));

vi.mock("@/app/settings/layout", () => ({
  useSetSettingsAction: () => mocks.setActionButton,
}));
vi.mock("next/navigation");

vi.mock("@/components/agent-icon-picker", () => ({
  AgentIconPicker: () => <button type="button">Choose icon</button>,
}));
vi.mock("@/components/roles/with-permissions", () => ({
  WithPermissions: ({ children }: { children: (value: unknown) => unknown }) =>
    children({ hasPermission: true }),
}));
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: () => ({ data: true }),
  // Full access to every credential, as an administrator holds it.
  useScopedCapabilities: () => ({
    data: ["read", "use", "update", "delete", "manage-permissions"].map(
      (action) => ({
        organizationId: "org",
        resource: "credential",
        scope: "*",
        action,
      }),
    ),
  }),
}));
vi.mock("@/lib/config/config.query", () => ({ useFeature: () => false }));
// The type-wide Permissions menu and the access section have their own tests.
vi.mock("@/components/resource-list-actions", () => ({
  ResourceListActions: () => null,
}));
vi.mock("@/components/resource-access-section", () => ({
  ResourceAccessSection: () => null,
}));
vi.mock("@/lib/runtime-credentials.query", () => ({
  useRuntimeCredentials: () => ({
    data: mocks.definitions,
    isPending: false,
    isError: false,
    refetch: mocks.refetch,
  }),
  useFilteredRuntimeCredentials: () => ({
    data: mocks.definitions,
    isPending: false,
    isError: false,
    refetch: mocks.refetch,
  }),
  useRuntimeCredentialUsage: mocks.useRuntimeCredentialUsage,
  useCreateRuntimeCredential: () => ({
    mutate: mocks.create,
    isPending: false,
  }),
  useSetRuntimeCredentialConnection: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useStartGitHubUserConnection: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useUpdateRuntimeCredential: () => ({
    mutate: mocks.update,
    isPending: false,
  }),
  useDeleteRuntimeCredential: () => ({
    mutate: mocks.deleteDefinition,
    isPending: false,
  }),
  useDeleteRuntimeCredentialConnection: () => ({
    mutate: mocks.disconnect,
    isPending: false,
  }),
}));

/**
 * The page's query string, which the router mock writes and `useSearchParams`
 * reads back, so a search or filter survives the navigation it causes.
 */
let url = new URLSearchParams();
const urlListeners = new Set<() => void>();
const navigate = (href: string) => {
  url = new URLSearchParams(href.split("?")[1] ?? "");
  for (const listener of urlListeners) listener();
};
const useUrl = () =>
  useSyncExternalStore(
    (listener) => {
      urlListeners.add(listener);
      return () => urlListeners.delete(listener);
    },
    () => url,
  );
const mockUrlNavigation = () => {
  url = new URLSearchParams();
  vi.mocked(usePathname).mockReturnValue("/settings/credentials");
  vi.mocked(useRouter).mockReturnValue({
    replace: vi.fn(navigate),
    push: vi.fn(navigate),
  } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(useSearchParams).mockImplementation(
    () => useUrl() as ReturnType<typeof useSearchParams>,
  );
};

describe("RuntimeCredentialsSection", () => {
  beforeEach(() => {
    mockUrlNavigation();
    vi.mocked(useAppName).mockReturnValue("Example Platform");
    vi.clearAllMocks();
    mocks.definitions = [
      {
        key: "github",
        name: "GitHub PAT",
        description: "Access GitHub repositories",
        icon: "logo:github",
        builtIn: true,
        allowPersonal: true,
        allowOrganization: false,
        personalConfigured: false,
        organizationConfigured: false,
      },
    ];
    mocks.useRuntimeCredentialUsage.mockReturnValue({
      data: { agents: [] },
      isPending: false,
      isError: false,
    });
    mocks.refetch.mockResolvedValue({
      data: [
        {
          id: "new-secret",
          key: "credential-team-secret",
          name: "Team secret",
          description: "",
          icon: null,
          kind: "secret",
          allowOrganization: true,
          allowPersonal: false,
          organizationConfigured: false,
        },
      ],
    });
  });

  it("creates a reusable definition with a generated stable key and chosen availability", async () => {
    const user = userEvent.setup();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(["secrets", "type"], { type: "database" });
    render(
      <QueryClientProvider client={client}>
        <RuntimeCredentialsSection />
      </QueryClientProvider>,
    );

    expect(screen.getByText("GitHub PAT")).toBeVisible();
    render(mocks.setActionButton.mock.calls.at(-1)?.[0]);
    await user.click(screen.getByRole("button", { name: "Add credential" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("Name"), "GitLab PAT");
    await user.click(
      within(dialog).getByRole("combobox", {
        name: "Provided by",
      }),
    );
    await user.click(screen.getByRole("option", { name: /Each user/ }));
    await user.click(within(dialog).getByRole("button", { name: "Add" }));

    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "credential-gitlab-pat",
        name: "GitLab PAT",
        allowPersonal: true,
        allowOrganization: false,
      }),
      expect.any(Object),
    );
  });

  it("opens the value dialog after adding an organization secret", async () => {
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RuntimeCredentialsSection />
      </QueryClientProvider>,
    );
    render(mocks.setActionButton.mock.calls.at(-1)?.[0]);
    await user.click(screen.getByRole("button", { name: "Add credential" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("Name"), "Team secret");
    await user.click(
      within(dialog).getByRole("combobox", { name: "Provided by" }),
    );
    await user.click(screen.getByRole("option", { name: /The organization/ }));
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    const onSuccess = mocks.create.mock.calls[0]?.[1].onSuccess;
    onSuccess({ id: "new-secret" });
    expect(
      await screen.findByRole("dialog", { name: "Connect Team secret" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Secret value")).toBeInTheDocument();
  });

  it("blocks deleting credentials still used by Agents", async () => {
    const user = userEvent.setup();
    mocks.definitions = [
      {
        key: "gitlab-pat",
        name: "GitLab PAT",
        description: "Access GitLab repositories",
        icon: "logo:gitlab",
        builtIn: false,
        allowPersonal: false,
        allowOrganization: true,
        personalConfigured: false,
        organizationConfigured: true,
      },
    ];
    mocks.useRuntimeCredentialUsage.mockReturnValue({
      data: { agents: [{ id: "agent-1", name: "Release Bot" }] },
      isPending: false,
      isError: false,
    });

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(["secrets", "type"], { type: "database" });
    render(
      <QueryClientProvider client={client}>
        <RuntimeCredentialsSection />
      </QueryClientProvider>,
    );
    await user.click(
      screen.getByRole("button", { name: "More actions GitLab PAT" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Release Bot");
    expect(
      within(dialog).getByRole("button", { name: "Delete" }),
    ).toBeDisabled();
    expect(mocks.deleteDefinition).not.toHaveBeenCalled();
  });
});
