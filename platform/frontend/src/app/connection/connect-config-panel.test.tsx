import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  useCreateConnectionPassthroughKey,
  useCreateConnectionVirtualKey,
} from "@/lib/connection-setup.query";
import { useAvailableLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { useOrganization } from "@/lib/organization.query";
import { useCreateSkillShareLink } from "@/lib/skills/skill-share.query";
import { downloadClaudeDesktopConfig } from "./claude-desktop-config";
import { ConnectConfigPanel } from "./connect-config-panel";
import { useAllSkills } from "./skills-marketplace-step";

const defaultSkillShareLinkMutation = vi.hoisted(() => ({
  mutateAsync: vi.fn().mockResolvedValue({
    cloneUrl: "https://localhost/skills/m/tok_default/repo.git",
    marketplaceName: "archestra-test-skills",
  }),
  isPending: false,
}));
const defaultAllSkillsQuery = vi.hoisted(() => ({ data: [] }));

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
  useCreateSkillShareLink: vi.fn(() => defaultSkillShareLinkMutation),
}));

vi.mock("./skills-marketplace-step", () => ({
  useAllSkills: vi.fn(() => defaultAllSkillsQuery),
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

// The gateway summary pulls its own unmocked queries; the visibility tests only
// care that the gateway review row (and thus step 5) is present, not its body.
vi.mock("./gateway-servers-summary", () => ({
  GatewayServersSummary: () => null,
}));

const proxy = {
  id: "proxy-1",
  name: "Prod Proxy",
  agentType: "llm_proxy" as const,
};

const gateway = {
  id: "gateway-1",
  name: "Prod Gateway",
  agentType: "mcp_gateway" as const,
};

const IMPORT_STEP_TITLE = "Import the profile into Claude Desktop";
const OAUTH_STEP_TITLE = "Finish the OAuth flow";
const SKILLS_STEP_TITLE = "Install shared skills";

function renderPanel({
  withGateway = false,
  skillsEnabled = true,
  llmProxyEnabled = true,
  llmProxyId = proxy.id,
  baseUrl = "https://localhost:9000/v1",
  candidateBaseUrls = [baseUrl],
}: {
  withGateway?: boolean;
  skillsEnabled?: boolean;
  llmProxyEnabled?: boolean;
  llmProxyId?: string | null;
  baseUrl?: string;
  candidateBaseUrls?: string[];
} = {}) {
  return render(
    <ConnectConfigPanel
      mcpGateways={withGateway ? [gateway] : null}
      mcpGatewayId={withGateway ? gateway.id : null}
      onMcpGatewaySelect={() => {}}
      gatewaySlug={withGateway ? gateway.id : null}
      llmProxyId={llmProxyId}
      baseUrl={baseUrl}
      candidateBaseUrls={candidateBaseUrls}
      baseUrlMetadata={null}
      onBaseUrlChange={() => {}}
      skillsEnabled={skillsEnabled}
      llmProxyEnabled={llmProxyEnabled}
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
  const provisionPassthrough = vi
    .fn()
    .mockResolvedValue({ value: "arch_passthrough" });
  const provisionVirtual = vi.fn().mockResolvedValue({ value: "arch_virtual" });
  vi.mocked(useCreateConnectionPassthroughKey).mockReturnValue({
    mutateAsync: provisionPassthrough,
    isPending: false,
  } as unknown as ReturnType<typeof useCreateConnectionPassthroughKey>);
  vi.mocked(useCreateConnectionVirtualKey).mockReturnValue({
    mutateAsync: provisionVirtual,
    isPending: false,
  } as unknown as ReturnType<typeof useCreateConnectionVirtualKey>);
  return { provisionPassthrough, provisionVirtual };
}

function getWizardStep(title: string) {
  const step = screen.getByRole("heading", { name: title }).closest("div.grid");
  if (!step) throw new Error(`Could not find wizard step: ${title}`);
  return step;
}

function expectStepNumber(title: string, number: number) {
  expect(getWizardStep(title).firstElementChild).toHaveTextContent(
    String(number),
  );
}

function expectStepToBeLast(title: string) {
  expect(getWizardStep(title).firstElementChild?.children).toHaveLength(1);
}

function expectStepToHaveConnector(title: string) {
  expect(getWizardStep(title).firstElementChild?.children).toHaveLength(2);
}

function createDeferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  if (!resolve) throw new Error("Deferred promise did not initialize");
  return { promise, resolve };
}

vi.mock("@/lib/organization.query");

// The components under test resolve provider labels through
// useModelProviderCatalog() -> useOrganization(); no organization data means
// "no admin overrides", i.e. every provider visible under its built-in name.
beforeEach(() => {
  vi.mocked(useOrganization).mockReturnValue({
    data: undefined,
  } as unknown as ReturnType<typeof useOrganization>);
});

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

describe("ConnectConfigPanel — HTTPS endpoint requirement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    grantAllPermissions();
    stubKeyProvisioning();
    vi.mocked(useAvailableLlmProviderApiKeys).mockReturnValue({
      data: [{ provider: "anthropic" }],
    } as ReturnType<typeof useAvailableLlmProviderApiKeys>);
  });

  it("offers the downloadable profile for local HTTP", async () => {
    renderPanel({ baseUrl: "http://localhost:3000/v1" });
    expect(await screen.findByTestId("connect-download-config")).toBeVisible();
  });

  it("does not offer a profile for an HTTP endpoint", () => {
    const { provisionPassthrough, provisionVirtual } = stubKeyProvisioning();
    renderPanel({ baseUrl: "http://stack.localhost:9003/v1" });

    expect(
      screen.getByText(/configuration profiles require an HTTPS endpoint/i),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("connect-download-config")).toBeNull();
    expect(provisionPassthrough).not.toHaveBeenCalled();
    expect(provisionVirtual).not.toHaveBeenCalled();
  });
});

describe("ConnectConfigPanel — shared skills marketplace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    grantAllPermissions();
    stubKeyProvisioning();
    vi.mocked(useCreateSkillShareLink).mockReturnValue(
      defaultSkillShareLinkMutation as unknown as ReturnType<
        typeof useCreateSkillShareLink
      >,
    );
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

    expect(
      screen.getByText(
        (_, el) => el?.tagName === "A" && el.textContent === "2 shared skills",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/Blog editor, Release notes/)).toBeInTheDocument();
  });

  it("does not prepare a marketplace when no configuration profile can be generated", () => {
    vi.mocked(useAllSkills).mockReturnValue({
      data: [{ id: "s1", name: "Blog editor" }],
    } as ReturnType<typeof useAllSkills>);

    renderPanel({ llmProxyId: null });

    expect(screen.getByRole("link", { name: "LLM Proxy" })).toBeInTheDocument();
    expect(defaultSkillShareLinkMutation.mutateAsync).not.toHaveBeenCalled();
  });

  it("prepares one marketplace before previewing and reuses it for every download", async () => {
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

    await waitFor(() =>
      expect(mintShareLink).toHaveBeenCalledWith({
        skillIds: ["s1", "s2"],
        expiresAt: null,
      }),
    );

    // The profile stays unavailable until both key and marketplace preparation
    // finish, so the preview has the actual marketplace name from the start.
    const downloadBtn = await screen.findByTestId("connect-download-config");
    await userEvent.click(
      screen.getByRole("button", { name: "Preview configuration" }),
    );
    const preview = document.querySelector("pre");
    expect(preview).toHaveTextContent('"marketplaces"');
    expect(preview).toHaveTextContent("archestra-acme-skills");
    expect(preview).not.toHaveTextContent("arch_passthrough");
    expect(preview).not.toHaveTextContent("arch_virtual");
    expect(preview).not.toHaveTextContent("tok_abc");
    await userEvent.click(downloadBtn);

    // The already-prepared clone URL rides into every generated profile.
    const [profile] = vi.mocked(downloadClaudeDesktopConfig).mock.calls[0];
    expect(profile.plugins?.marketplaces).toEqual([
      {
        source: "git",
        url: "https://localhost/skills/m/tok_abc/repo.git",
        expectedName: "archestra-acme-skills",
      },
    ]);
    await userEvent.click(downloadBtn);
    expect(mintShareLink).toHaveBeenCalledTimes(1);
    expect(vi.mocked(downloadClaudeDesktopConfig).mock.calls[1][0]).toEqual(
      profile,
    );
  });

  it("blocks an HTTP marketplace URL before downloading the profile", async () => {
    vi.mocked(useCreateSkillShareLink).mockReturnValue({
      mutateAsync: vi.fn().mockResolvedValue({
        cloneUrl: "http://stack.localhost:9003/skills/m/tok_http/repo.git",
        marketplaceName: "archestra-http-skills",
      }),
      isPending: false,
    } as unknown as ReturnType<typeof useCreateSkillShareLink>);
    vi.mocked(useAllSkills).mockReturnValue({
      data: [{ id: "s1", name: "Blog editor" }],
    } as ReturnType<typeof useAllSkills>);

    renderPanel();

    expect(
      await screen.findByText(/shared skills marketplace needs an HTTPS URL/i),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("connect-download-config")).toBeNull();
  });

  it("blocks the download while the deferred skills catalogue is loading", async () => {
    vi.mocked(useAllSkills).mockReturnValue({
      data: undefined,
      isError: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useAllSkills>);

    renderPanel();

    expect(
      await screen.findByText("Preparing your shared skills marketplace…"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("connect-download-config")).toBeNull();
    expect(defaultSkillShareLinkMutation.mutateAsync).not.toHaveBeenCalled();
  });

  it("keeps the selected skills out of downloads until failed preparation is retried", async () => {
    const mintShareLink = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        cloneUrl: "https://localhost/skills/m/tok_retry/repo.git",
        marketplaceName: "archestra-retry-skills",
      });
    vi.mocked(useCreateSkillShareLink).mockReturnValue({
      mutateAsync: mintShareLink,
      isPending: false,
    } as unknown as ReturnType<typeof useCreateSkillShareLink>);
    vi.mocked(useAllSkills).mockReturnValue({
      data: [{ id: "s1", name: "Blog editor" }],
    } as ReturnType<typeof useAllSkills>);

    renderPanel();

    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(retry.parentElement).toHaveTextContent(
      "Couldn't prepare your shared skills marketplace.",
    );
    expect(screen.queryByTestId("connect-download-config")).toBeNull();
    await userEvent.click(retry);
    await screen.findByTestId("connect-download-config");
    expect(mintShareLink).toHaveBeenCalledTimes(2);
    await userEvent.click(
      screen.getByRole("button", { name: "Preview configuration" }),
    );
    expect(document.querySelector("pre")).toHaveTextContent(
      "archestra-retry-skills",
    );
  });

  it("ignores a stale marketplace response after shared skills are disabled", async () => {
    const firstMarketplace = createDeferred<{
      cloneUrl: string;
      marketplaceName: string;
    }>();
    const mintShareLink = vi
      .fn()
      .mockReturnValueOnce(firstMarketplace.promise)
      .mockResolvedValueOnce({
        cloneUrl: "https://localhost/skills/m/tok_new/repo.git",
        marketplaceName: "archestra-new-skills",
      });
    vi.mocked(useCreateSkillShareLink).mockReturnValue({
      mutateAsync: mintShareLink,
      isPending: false,
    } as unknown as ReturnType<typeof useCreateSkillShareLink>);
    vi.mocked(useAllSkills).mockReturnValue({
      data: [{ id: "s1", name: "Blog editor" }],
    } as ReturnType<typeof useAllSkills>);

    renderPanel();

    await waitFor(() => expect(mintShareLink).toHaveBeenCalledTimes(1));
    const skillsRow = screen
      .getByText(
        (_, el) => el?.tagName === "A" && el.textContent === "1 shared skill",
      )
      .closest("li");
    if (!skillsRow) throw new Error("Could not find shared skills review row");
    await userEvent.click(
      within(skillsRow).getByRole("button", { name: "Change" }),
    );
    await userEvent.click(
      within(skillsRow).getByRole("checkbox", {
        name: "Install shared skills",
      }),
    );

    firstMarketplace.resolve({
      cloneUrl: "https://localhost/skills/m/tok_old/repo.git",
      marketplaceName: "archestra-old-skills",
    });
    await screen.findByTestId("connect-download-config");
    expect(
      screen.queryByRole("heading", { name: SKILLS_STEP_TITLE }),
    ).not.toBeInTheDocument();

    await userEvent.click(
      within(skillsRow).getByRole("checkbox", {
        name: "Install shared skills",
      }),
    );
    await waitFor(() => expect(mintShareLink).toHaveBeenCalledTimes(2));
    await screen.findByTestId("connect-download-config");
    await userEvent.click(
      screen.getByRole("button", { name: "Preview configuration" }),
    );
    expect(document.querySelector("pre")).toHaveTextContent(
      "archestra-new-skills",
    );
    await userEvent.click(screen.getByTestId("connect-download-config"));
    expect(
      vi.mocked(downloadClaudeDesktopConfig).mock.calls[0][0].plugins,
    ).toEqual({
      marketplaces: [
        {
          source: "git",
          url: "https://localhost/skills/m/tok_new/repo.git",
          expectedName: "archestra-new-skills",
        },
      ],
    });
  });

  it("shows post-import installation guidance only while shared skills are included", async () => {
    vi.mocked(useAllSkills).mockReturnValue({
      data: [
        { id: "s1", name: "Blog editor" },
        { id: "s2", name: "Release notes" },
      ],
    } as ReturnType<typeof useAllSkills>);

    renderPanel();

    await screen.findByTestId("connect-download-config");
    await userEvent.click(
      screen.getByRole("button", { name: "Preview configuration" }),
    );
    expect(document.querySelector("pre")).toHaveTextContent('"marketplaces"');
    expect(
      screen.getByRole("heading", { name: SKILLS_STEP_TITLE }),
    ).toBeInTheDocument();
    expect(getWizardStep(SKILLS_STEP_TITLE)).toHaveTextContent(
      "Settings → Plugins → Browse plugins.",
    );
    expect(getWizardStep(SKILLS_STEP_TITLE)).toHaveTextContent(
      "Install the archestra-test-skills marketplace.",
    );
    expectStepNumber(IMPORT_STEP_TITLE, 4);
    expectStepNumber(SKILLS_STEP_TITLE, 5);
    expectStepToHaveConnector(IMPORT_STEP_TITLE);
    expectStepToBeLast(SKILLS_STEP_TITLE);

    const skillsRow = screen
      .getByText(
        (_, el) => el?.tagName === "A" && el.textContent === "2 shared skills",
      )
      .closest("li");
    if (!skillsRow) throw new Error("Could not find shared skills review row");
    await userEvent.click(
      within(skillsRow).getByRole("button", { name: "Change" }),
    );
    await userEvent.click(
      within(skillsRow).getByRole("checkbox", {
        name: "Install shared skills",
      }),
    );

    expect(
      screen.queryByRole("heading", { name: SKILLS_STEP_TITLE }),
    ).not.toBeInTheDocument();
    expect(document.querySelector("pre")).not.toHaveTextContent(
      '"marketplaces"',
    );
    expectStepToBeLast(IMPORT_STEP_TITLE);
  });

  it("uses the newly resolved marketplace name after a page remount", async () => {
    const mintShareLink = vi
      .fn()
      .mockResolvedValueOnce({
        cloneUrl: "https://localhost/skills/m/tok_first/repo.git",
        marketplaceName: "archestra-first-skills",
      })
      .mockResolvedValueOnce({
        cloneUrl: "https://localhost/skills/m/tok_second/repo.git",
        marketplaceName: "archestra-second-skills",
      });
    vi.mocked(useCreateSkillShareLink).mockReturnValue({
      mutateAsync: mintShareLink,
      isPending: false,
    } as unknown as ReturnType<typeof useCreateSkillShareLink>);
    vi.mocked(useAllSkills).mockReturnValue({
      data: [{ id: "s1", name: "Blog editor" }],
    } as ReturnType<typeof useAllSkills>);

    const firstPage = renderPanel();
    await screen.findByTestId("connect-download-config");
    expect(getWizardStep(SKILLS_STEP_TITLE)).toHaveTextContent(
      "Install the archestra-first-skills marketplace.",
    );
    await userEvent.click(screen.getByTestId("connect-download-config"));
    expect(
      vi.mocked(downloadClaudeDesktopConfig).mock.calls[0][0].plugins
        ?.marketplaces[0].expectedName,
    ).toBe("archestra-first-skills");

    firstPage.unmount();
    renderPanel();

    await screen.findByTestId("connect-download-config");
    expect(getWizardStep(SKILLS_STEP_TITLE)).toHaveTextContent(
      "Install the archestra-second-skills marketplace.",
    );
    await userEvent.click(screen.getByTestId("connect-download-config"));
    expect(
      vi.mocked(downloadClaudeDesktopConfig).mock.calls[1][0].plugins
        ?.marketplaces[0].expectedName,
    ).toBe("archestra-second-skills");
  });
});

describe("ConnectConfigPanel — import & OAuth step visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubKeyProvisioning();
    vi.mocked(useCreateSkillShareLink).mockReturnValue(
      defaultSkillShareLinkMutation as unknown as ReturnType<
        typeof useCreateSkillShareLink
      >,
    );
  });

  it("shows the import and OAuth steps once a profile can be downloaded", async () => {
    grantAllPermissions();
    vi.mocked(useAvailableLlmProviderApiKeys).mockReturnValue({
      data: [{ provider: "anthropic" }],
    } as ReturnType<typeof useAvailableLlmProviderApiKeys>);
    vi.mocked(useAllSkills).mockReturnValue({
      data: [{ id: "s1", name: "Blog editor" }],
    } as ReturnType<typeof useAllSkills>);

    renderPanel({ withGateway: true });

    // The download button only renders once key provisioning resolves; both
    // follow-up steps are present alongside the desktop-only skills step.
    await screen.findByTestId("connect-download-config");
    expect(screen.getByText(IMPORT_STEP_TITLE)).toBeInTheDocument();
    expect(screen.getByText(SKILLS_STEP_TITLE)).toBeInTheDocument();
    expect(screen.getByText(OAUTH_STEP_TITLE)).toBeInTheDocument();
    expectStepNumber(SKILLS_STEP_TITLE, 5);
    expectStepNumber(OAUTH_STEP_TITLE, 6);
    expectStepToHaveConnector(SKILLS_STEP_TITLE);
    expectStepToBeLast(OAUTH_STEP_TITLE);
  });

  it("hides the import and OAuth steps when no Anthropic key is configured", () => {
    grantAllPermissions();
    // A key exists, but not for Anthropic — the profile still can't be minted.
    vi.mocked(useAvailableLlmProviderApiKeys).mockReturnValue({
      data: [{ provider: "openai" }],
    } as ReturnType<typeof useAvailableLlmProviderApiKeys>);

    renderPanel({ withGateway: true });

    // Step 3 still renders and explains the blocker...
    expect(screen.getByText(/authorize inference/)).toBeInTheDocument();
    // ...but the steps that depend on a downloaded profile are gone.
    expect(screen.queryByText(IMPORT_STEP_TITLE)).toBeNull();
    expect(screen.queryByText(OAUTH_STEP_TITLE)).toBeNull();
  });

  it("hides the import and OAuth steps when the user can't create virtual keys", () => {
    // Everything permitted except minting virtual keys — the profile can never
    // be produced, so the follow-up steps are noise.
    vi.mocked(useHasPermissions).mockImplementation((perms) => {
      const isVirtualKeyCreate =
        JSON.stringify(perms) === JSON.stringify({ llmVirtualKey: ["create"] });
      return { data: !isVirtualKeyCreate } as ReturnType<
        typeof useHasPermissions
      >;
    });
    vi.mocked(useAvailableLlmProviderApiKeys).mockReturnValue({
      data: [{ provider: "anthropic" }],
    } as ReturnType<typeof useAvailableLlmProviderApiKeys>);

    renderPanel({ withGateway: true });

    expect(screen.queryByText(IMPORT_STEP_TITLE)).toBeNull();
    expect(screen.queryByText(OAUTH_STEP_TITLE)).toBeNull();
  });

  it("hides the skills row when connecting skills is disabled", () => {
    vi.mocked(useAllSkills).mockReturnValue({
      data: [{ id: "s1", name: "Blog editor" }],
    } as ReturnType<typeof useAllSkills>);

    renderPanel({ skillsEnabled: false });

    expect(screen.queryByText(/Install shared skills/)).toBeNull();
  });

  it("keeps Claude Desktop MCP-only when the LLM Proxy is disabled", () => {
    renderPanel({ withGateway: true, llmProxyEnabled: false });

    expect(
      screen.queryByText(/reuse a Claude Pro or Max subscription/),
    ).toBeNull();
    expect(screen.getByText(IMPORT_STEP_TITLE)).toBeInTheDocument();
    expect(screen.getByText(OAUTH_STEP_TITLE)).toBeInTheDocument();
    expect(screen.getByText(/Prod Gateway/)).toBeInTheDocument();
  });
});
