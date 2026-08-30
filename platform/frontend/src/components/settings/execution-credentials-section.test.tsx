import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionCredentialsSection } from "./execution-credentials-section";

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
  create: vi.fn(),
  update: vi.fn(),
  deleteDefinition: vi.fn(),
  disconnect: vi.fn(),
  useExecutionCredentialUsage: vi.fn(),
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

vi.mock("@/components/agent-icon-picker", () => ({
  AgentIconPicker: () => <button type="button">Choose icon</button>,
}));
vi.mock("@/components/roles/with-permissions", () => ({
  WithPermissions: ({ children }: { children: (value: unknown) => unknown }) =>
    children({ hasPermission: true }),
}));
vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: () => ({ data: true }),
}));
vi.mock("@/lib/config/config.query", () => ({ useFeature: () => false }));
vi.mock("@/lib/execution-credentials.query", () => ({
  useExecutionCredentials: () => ({
    data: mocks.definitions,
    isPending: false,
    isError: false,
  }),
  useExecutionCredentialUsage: mocks.useExecutionCredentialUsage,
  useCreateExecutionCredential: () => ({
    mutate: mocks.create,
    isPending: false,
  }),
  useUpdateExecutionCredential: () => ({
    mutate: mocks.update,
    isPending: false,
  }),
  useDeleteExecutionCredential: () => ({
    mutate: mocks.deleteDefinition,
    isPending: false,
  }),
  useDeleteExecutionCredentialConnection: () => ({
    mutate: mocks.disconnect,
    isPending: false,
  }),
}));

describe("ExecutionCredentialsSection", () => {
  beforeEach(() => {
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
    mocks.useExecutionCredentialUsage.mockReturnValue({
      data: { agents: [] },
      isPending: false,
      isError: false,
    });
  });

  it("creates a reusable definition with a generated stable key and chosen availability", async () => {
    const user = userEvent.setup();
    render(<ExecutionCredentialsSection />);

    expect(screen.getByText("GitHub PAT")).toBeVisible();
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
        key: "gitlab-pat",
        name: "GitLab PAT",
        allowPersonal: true,
        allowOrganization: false,
      }),
      expect.any(Object),
    );
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
    mocks.useExecutionCredentialUsage.mockReturnValue({
      data: { agents: [{ id: "agent-1", name: "Release Bot" }] },
      isPending: false,
      isError: false,
    });

    render(<ExecutionCredentialsSection />);
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
