import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  useCreateConnectionPassthroughKey,
  useCreateConnectionVirtualKey,
} from "@/lib/connection-setup.query";
import { useAvailableLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { useCreateSkillShareLink } from "@/lib/skills/skill-share.query";
import { downloadClaudeDesktopConfig } from "./claude-desktop-config";
import { ConnectConfigPanel } from "./connect-config-panel";
import { useAllSkills } from "./skills-marketplace-step";

vi.mock("@/lib/auth/auth.query");

// Default impls survive vi.clearAllMocks (which resets call history, not
// implementations); the skills suite overrides them to resolve real key values.
vi.mock("@/lib/connection-setup.query", () => ({
  useCreateConnectionPassthroughKey: vi.fn(() => ({
    mutateAsync: vi.fn(),
    isPending: false,
  })),
  useCreateConnectionVirtualKey: vi.fn(() => ({
    mutateAsync: vi.fn(),
    isPending: false,
  })),
}));

vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  useAvailableLlmProviderApiKeys: vi.fn(() => ({ data: [] })),
}));

vi.mock("@/lib/skills/skill-share.query", () => ({
  useCreateSkillShareLink: vi.fn(() => ({
    mutateAsync: vi.fn(),
    isPending: false,
  })),
}));

vi.mock("./skills-marketplace-step", () => ({
  useAllSkills: vi.fn(() => ({ data: [] })),
}));

// Keep the real profile builder; only stub the blob-download side effect, which
// jsdom can't perform.
vi.mock("./claude-desktop-config", async (importActual) => ({
  ...(await importActual<typeof import("./claude-desktop-config")>()),
  downloadClaudeDesktopConfig: vi.fn(),
}));

vi.mock("@/components/create-llm-provider-api-key-dialog", () => ({
  CreateLlmProviderApiKeyDialog: () => null,
}));

const proxy = {
  id: "proxy-1",
  name: "Prod Proxy",
  agentType: "llm_proxy" as const,
};

function renderPanel() {
  return render(
    <ConnectConfigPanel
      mcpGateways={null}
      mcpGatewayId={null}
      onMcpGatewaySelect={() => {}}
      gatewaySlug={null}
      llmProxies={[proxy]}
      llmProxyId={proxy.id}
      onLlmProxySelect={() => {}}
      baseUrl="http://localhost:9000/v1"
      candidateBaseUrls={["http://localhost:9000/v1"]}
      baseUrlMetadata={null}
      onBaseUrlChange={() => {}}
    />,
  );
}

/** All queried permissions resolve true. */
function grantAllPermissions() {
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
  } as ReturnType<typeof useHasPermissions>);
}

/** Provisioning of both connection keys resolves so the download step renders. */
function stubKeyProvisioning() {
  vi.mocked(useCreateConnectionPassthroughKey).mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue({ value: "arch_passthrough" }),
    isPending: false,
  } as unknown as ReturnType<typeof useCreateConnectionPassthroughKey>);
  vi.mocked(useCreateConnectionVirtualKey).mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue({ value: "arch_virtual" }),
    isPending: false,
  } as unknown as ReturnType<typeof useCreateConnectionVirtualKey>);
}

describe("ConnectConfigPanel — Claude Desktop subscription note", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Short-circuit the download step's provisioning; the subscription note
    // opens the download step but sits outside the provisioning flow, so it
    // renders regardless.
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
    } as ReturnType<typeof useHasPermissions>);
  });

  it("notes that the proxy can't reuse a Claude subscription and points to Claude Code", () => {
    renderPanel();

    expect(
      screen.getByText(/reuse a Claude Pro or Max subscription/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/connect Claude Code in passthrough mode/),
    ).toBeInTheDocument();
  });
});

describe("ConnectConfigPanel — shared skills marketplace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    grantAllPermissions();
    stubKeyProvisioning();
    // A configured Anthropic key so the standard virtual key can be minted and
    // the download step reaches its ready state.
    vi.mocked(useAvailableLlmProviderApiKeys).mockReturnValue({
      data: [{ provider: "anthropic" }],
    } as ReturnType<typeof useAvailableLlmProviderApiKeys>);
  });

  it("hides the skills row when the caller isn't a skill admin", () => {
    vi.mocked(useHasPermissions).mockImplementation((perms) => {
      const isSkillAdmin =
        JSON.stringify(perms) === JSON.stringify({ skill: ["admin"] });
      return { data: !isSkillAdmin } as ReturnType<typeof useHasPermissions>;
    });
    vi.mocked(useAllSkills).mockReturnValue({
      data: [{ id: "s1", name: "Blog editor" }],
    } as ReturnType<typeof useAllSkills>);

    renderPanel();

    expect(screen.queryByText(/Install .* shared skill/)).toBeNull();
  });

  it("shows the skills row and names the skills when eligible", () => {
    vi.mocked(useAllSkills).mockReturnValue({
      data: [
        { id: "s1", name: "Blog editor" },
        { id: "s2", name: "Release notes" },
      ],
    } as ReturnType<typeof useAllSkills>);

    renderPanel();

    expect(screen.getByText(/Install/)).toBeInTheDocument();
    expect(screen.getByText(/2 shared skills/)).toBeInTheDocument();
    expect(screen.getByText(/Blog editor, Release notes/)).toBeInTheDocument();
  });

  it("mints a never-expiring share link on download and embeds it in the profile", async () => {
    const mintShareLink = vi.fn().mockResolvedValue({
      cloneUrl: "https://localhost/skills/m/tok_abc/repo.git",
      marketplaceName: "archestra-acme-skills",
    });
    vi.mocked(useCreateSkillShareLink).mockReturnValue({
      mutateAsync: mintShareLink,
      isPending: false,
    } as unknown as ReturnType<typeof useCreateSkillShareLink>);
    vi.mocked(useAllSkills).mockReturnValue({
      data: [
        { id: "s1", name: "Blog editor" },
        { id: "s2", name: "Release notes" },
      ],
    } as ReturnType<typeof useAllSkills>);

    renderPanel();

    // Wait out the async key provisioning so the download button renders.
    const downloadBtn = await screen.findByTestId("connect-download-config");
    await userEvent.click(downloadBtn);

    await waitFor(() =>
      expect(mintShareLink).toHaveBeenCalledWith({
        skillIds: ["s1", "s2"],
        expiresAt: null,
      }),
    );
    // The freshly minted clone URL rode into the built profile.
    const [profile] = vi.mocked(downloadClaudeDesktopConfig).mock.calls[0];
    expect(profile.plugins?.marketplaces).toEqual([
      {
        source: "git",
        url: "https://localhost/skills/m/tok_abc/repo.git",
        expectedName: "archestra-acme-skills",
      },
    ]);
  });
});
