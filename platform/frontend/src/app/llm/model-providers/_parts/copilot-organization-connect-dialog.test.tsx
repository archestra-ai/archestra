import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useCheckCopilotGithubOrganization,
  useCompleteCopilotGithubApp,
  useConnectExistingCopilotGithubApp,
  useDiscardCopilotGithubApp,
  useInstallCopilotGithubApp,
  usePendingCopilotGithubApp,
  useStartCopilotGithubApp,
  useValidateExistingCopilotGithubApp,
} from "@/lib/github-copilot-app.query";
import {
  CopilotOrganizationConnectDialog,
  hasClaudeOrGemini,
} from "./copilot-organization-connect-dialog";

vi.mock("@/lib/github-copilot-app.query", () => ({
  useCheckCopilotGithubOrganization: vi.fn(),
  useCompleteCopilotGithubApp: vi.fn(),
  useConnectExistingCopilotGithubApp: vi.fn(),
  useDiscardCopilotGithubApp: vi.fn(),
  useInstallCopilotGithubApp: vi.fn(),
  usePendingCopilotGithubApp: vi.fn(),
  useStartCopilotGithubApp: vi.fn(),
  useValidateExistingCopilotGithubApp: vi.fn(),
}));
vi.mock("@/components/resource-access-section", () => ({
  ResourceAccessSection: () => <div>Access picker</div>,
}));

/** A mutation double: `mutate` calls `onSuccess` with `result`. */
function mutation(result?: unknown, extra?: Record<string, unknown>) {
  return {
    mutate: vi.fn(
      (_body: unknown, options?: { onSuccess?: (data: unknown) => void }) =>
        options?.onSuccess?.(result),
    ),
    reset: vi.fn(),
    isPending: false,
    error: null,
    data: undefined,
    ...extra,
  };
}

beforeEach(() => {
  vi.mocked(usePendingCopilotGithubApp).mockReturnValue({
    data: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof usePendingCopilotGithubApp>);
  for (const hook of [
    useCheckCopilotGithubOrganization,
    useStartCopilotGithubApp,
    useCompleteCopilotGithubApp,
    useInstallCopilotGithubApp,
    useDiscardCopilotGithubApp,
  ])
    vi.mocked(hook).mockReturnValue(mutation() as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CopilotOrganizationConnectDialog", () => {
  it("states what the App may and may not do before creating it", async () => {
    const user = userEvent.setup();
    vi.mocked(useValidateExistingCopilotGithubApp).mockReturnValue(
      mutation() as never,
    );
    vi.mocked(useConnectExistingCopilotGithubApp).mockReturnValue(
      mutation() as never,
    );
    render(<CopilotOrganizationConnectDialog open onOpenChange={vi.fn()} />);

    const create = screen.getByRole("button", {
      name: "Create the App on GitHub",
    });
    expect(create).toBeDisabled();
    await user.type(screen.getByLabelText("GitHub organization"), "my-org");
    expect(create).toBeEnabled();
    expect(
      screen.getByText("Make Copilot requests, paid from my-org's AI credits"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Read code, repositories, issues or members"),
    ).toBeInTheDocument();
  });

  it("asks for the organization in one field and shows the backend's message under it", async () => {
    const user = userEvent.setup();
    vi.mocked(useValidateExistingCopilotGithubApp).mockReturnValue(
      mutation() as never,
    );
    vi.mocked(useConnectExistingCopilotGithubApp).mockReturnValue(
      mutation() as never,
    );
    const start = mutation();
    vi.mocked(useStartCopilotGithubApp).mockReturnValue({
      ...start,
      error: new Error("Enter an organization name or its GitHub address."),
    } as never);
    vi.spyOn(window, "open").mockReturnValue(null);
    render(<CopilotOrganizationConnectDialog open onOpenChange={vi.fn()} />);

    // One organization field; no separate GitHub Enterprise address.
    expect(screen.getAllByLabelText("GitHub organization")).toHaveLength(1);
    expect(screen.queryByText(/Enterprise address/)).not.toBeInTheDocument();
    const field = screen.getByLabelText("GitHub organization");
    expect(field).toHaveAttribute(
      "placeholder",
      "my-org or https://github.com/my-org",
    );
    // The error takes the help text's place under the field.
    expect(field).toHaveAccessibleDescription(
      "Enter an organization name or its GitHub address.",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter an organization name or its GitHub address.",
    );
    expect(
      screen.queryByText("Organization's GitHub handle or URL"),
    ).not.toBeInTheDocument();

    await user.type(field, "https://github.example.com/other-org/settings");
    expect(
      screen.getByText(
        "Make Copilot requests, paid from other-org's AI credits",
      ),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Create the App on GitHub" }),
    );
    expect(start.mutate).toHaveBeenCalledWith(
      { organization: "https://github.example.com/other-org/settings" },
      expect.anything(),
    );
  });

  it("resumes on the install step when an App awaits installation", () => {
    vi.mocked(usePendingCopilotGithubApp).mockReturnValue({
      data: {
        name: "My Org Copilot",
        slug: "my-org-copilot",
        organization: "my-org",
        appId: "1",
        installUrl: "https://github.com/apps/my-org-copilot/installations/new",
        settingsUrl: "https://github.com/organizations/my-org/settings/apps/x",
      },
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof usePendingCopilotGithubApp>);
    vi.mocked(useValidateExistingCopilotGithubApp).mockReturnValue(
      mutation() as never,
    );
    vi.mocked(useConnectExistingCopilotGithubApp).mockReturnValue(
      mutation() as never,
    );
    render(<CopilotOrganizationConnectDialog open onOpenChange={vi.fn()} />);

    expect(
      screen.getByRole("button", { name: "Install on my-org" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "If you're not an owner of my-org, GitHub sends the request to an owner. This finishes once they approve.",
      ),
    ).toBeInTheDocument();
  });

  it("connects an existing App and warns when Claude and Gemini are missing", async () => {
    const user = userEvent.setup();
    vi.mocked(useValidateExistingCopilotGithubApp).mockReturnValue(
      mutation(undefined, {
        data: {
          fingerprint: "SHA256:abc=",
          installationId: "5",
          organization: "my-org",
        },
      }) as never,
    );
    const connect = mutation({
      status: "installed",
      id: "key-1",
      organization: "my-org",
      modelIds: ["gpt-4o", "gpt-4.1"],
    });
    vi.mocked(useConnectExistingCopilotGithubApp).mockReturnValue(
      connect as never,
    );
    render(<CopilotOrganizationConnectDialog open onOpenChange={vi.fn()} />);

    await user.type(screen.getByLabelText("GitHub organization"), "my-org");
    await user.click(
      screen.getByRole("button", { name: "Use an existing App" }),
    );
    // The organization comes from the first step; no field asks for it again.
    expect(screen.queryByLabelText("GitHub organization")).toBeNull();
    expect(screen.getByText("Organization: my-org")).toBeInTheDocument();
    await user.type(screen.getByLabelText("App ID"), "42");
    await user.upload(
      screen.getByLabelText("Private key"),
      new File(["-----BEGIN RSA PRIVATE KEY-----secret"], "app.pem"),
    );
    // The key is never rendered; only GitHub's fingerprint of it is.
    expect(screen.queryByText(/BEGIN RSA PRIVATE KEY/)).not.toBeInTheDocument();
    expect(screen.getByText("SHA256:abc=")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(connect.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: "42",
        organization: "my-org",
        privateKey: "-----BEGIN RSA PRIVATE KEY-----secret",
      }),
      expect.anything(),
    );
    expect(screen.getByText("Connected. 2 models:")).toBeInTheDocument();
    expect(
      screen.getByText(
        "No Claude or Gemini models. my-org's Copilot model policy may have them switched off.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Access picker")).toBeInTheDocument();
  });
});

describe("CopilotOrganizationConnectDialog existing App path", () => {
  it("checks the organization before Use an existing App, with the error under the field", async () => {
    const user = userEvent.setup();
    vi.mocked(useValidateExistingCopilotGithubApp).mockReturnValue(
      mutation() as never,
    );
    vi.mocked(useConnectExistingCopilotGithubApp).mockReturnValue(
      mutation() as never,
    );
    const check = {
      ...mutation(),
      mutate: vi.fn(),
      error: new Error(
        "GitHub Copilot needs an organization on Copilot Business or Enterprise.",
      ),
    };
    vi.mocked(useCheckCopilotGithubOrganization).mockReturnValue(
      check as never,
    );
    render(<CopilotOrganizationConnectDialog open onOpenChange={vi.fn()} />);

    await user.type(screen.getByLabelText("GitHub organization"), "someone");
    await user.click(
      screen.getByRole("button", { name: "Use an existing App" }),
    );

    expect(check.mutate).toHaveBeenCalledWith(
      { organization: "someone" },
      expect.anything(),
    );
    // Still on the first step, the message under the field.
    expect(screen.getByLabelText("GitHub organization")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "GitHub Copilot needs an organization on Copilot Business or Enterprise.",
    );
  });

  it("reconnects with the organization stored on the key", async () => {
    const user = userEvent.setup();
    vi.mocked(useValidateExistingCopilotGithubApp).mockReturnValue(
      mutation(undefined, {
        data: {
          fingerprint: "SHA256:abc=",
          installationId: "5",
          organization: "other-org",
        },
      }) as never,
    );
    const connect = mutation({
      status: "installed",
      id: "key-1",
      organization: "other-org",
      modelIds: ["claude-sonnet-4"],
    });
    vi.mocked(useConnectExistingCopilotGithubApp).mockReturnValue(
      connect as never,
    );
    render(
      <CopilotOrganizationConnectDialog
        open
        onOpenChange={vi.fn()}
        replace={{ id: "key-1", organization: "other-org" }}
      />,
    );

    expect(screen.queryByLabelText("GitHub organization")).toBeNull();
    await user.type(screen.getByLabelText("App ID"), "42");
    await user.upload(
      screen.getByLabelText("Private key"),
      new File(["pem"], "app.pem"),
    );
    await user.click(
      screen.getByRole("button", { name: "Replace credentials" }),
    );

    expect(connect.mutate).toHaveBeenCalledWith(
      { appId: "42", privateKey: "pem", replaceKeyId: "key-1" },
      expect.anything(),
    );
  });
});

describe("hasClaudeOrGemini", () => {
  it("recognizes Claude or Gemini model ids", () => {
    expect(hasClaudeOrGemini(["gpt-4o", "claude-sonnet-4"])).toBe(true);
    expect(hasClaudeOrGemini(["gemini-2.5-pro"])).toBe(true);
    expect(hasClaudeOrGemini(["gpt-4o"])).toBe(false);
  });
});
