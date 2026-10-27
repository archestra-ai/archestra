import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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
    await user.type(screen.getByLabelText("GitHub organization"), "acme");
    expect(create).toBeEnabled();
    expect(
      screen.getByText("Make Copilot requests, paid from acme's AI credits"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Read code, repositories, issues or members"),
    ).toBeInTheDocument();
  });

  it("resumes on the install step when an App awaits installation", () => {
    vi.mocked(usePendingCopilotGithubApp).mockReturnValue({
      data: {
        name: "Archestra Copilot",
        slug: "archestra-copilot",
        organization: "acme",
        appId: "1",
        installUrl:
          "https://github.com/apps/archestra-copilot/installations/new",
        settingsUrl: "https://github.com/organizations/acme/settings/apps/x",
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
      screen.getByRole("button", { name: "Install on acme" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "If you're not an owner of acme, GitHub sends the request to an owner. This finishes once they approve.",
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
          organization: "acme",
        },
      }) as never,
    );
    const connect = mutation({
      status: "installed",
      id: "key-1",
      organization: "acme",
      modelIds: ["gpt-4o", "gpt-4.1"],
    });
    vi.mocked(useConnectExistingCopilotGithubApp).mockReturnValue(
      connect as never,
    );
    render(<CopilotOrganizationConnectDialog open onOpenChange={vi.fn()} />);

    await user.click(
      screen.getByRole("button", { name: "Use an existing App" }),
    );
    await user.type(screen.getByLabelText("App ID"), "42");
    await user.type(screen.getByLabelText("GitHub organization"), "acme");
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
        organization: "acme",
        privateKey: "-----BEGIN RSA PRIVATE KEY-----secret",
      }),
      expect.anything(),
    );
    expect(screen.getByText("Connected. 2 models:")).toBeInTheDocument();
    expect(
      screen.getByText(
        "No Claude or Gemini models. acme's Copilot model policy may have them switched off.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Access picker")).toBeInTheDocument();
  });
});

describe("hasClaudeOrGemini", () => {
  it("recognizes Claude or Gemini model ids", () => {
    expect(hasClaudeOrGemini(["gpt-4o", "claude-sonnet-4"])).toBe(true);
    expect(hasClaudeOrGemini(["gemini-2.5-pro"])).toBe(true);
    expect(hasClaudeOrGemini(["gpt-4o"])).toBe(false);
  });
});
