import {
  archestraApiSdk,
  buildAgentCatalogRuntime,
  getAgentCatalogImages,
  withAgentRuntimeDefaults,
} from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useAgentRuntimePermissions,
  useBuiltInRuntimeDefaults,
} from "./agent-runtime-templates.query";

vi.mock("@archestra/shared/api-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@archestra/shared/api-sdk")>()),
  listAgentRuntimeAccess: vi.fn(),
  listAgentRuntimeTemplates: vi.fn(),
  listBuiltInAgentRuntimeSettings: vi.fn(),
  getAgentRuntimeTemplate: vi.fn(),
}));

const sdk = vi.mocked(archestraApiSdk);
const catalogImages = getAgentCatalogImages({
  registry: "mirror.example.com/archestra",
  tag: "1.5.0",
});
const customId = "c0ffee00-0000-4000-8000-000000000001";

describe("useAgentRuntimePermissions", () => {
  afterEach(() => vi.clearAllMocks());

  it("tells use from configure, per runtime and for an image no runtime owns", async () => {
    sdk.listAgentRuntimeTemplates.mockResolvedValue({
      data: [
        { id: customId, name: "Team runtime", image: "example.com/own:v1" },
      ],
      error: undefined,
    } as never);
    sdk.listAgentRuntimeAccess.mockResolvedValue({
      data: {
        runtimes: [{ id: customId, canUse: true, canConfigure: false }],
        canConfigureAny: false,
      },
      error: undefined,
    } as never);
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const read = (image: string) =>
      renderHook(
        () =>
          useAgentRuntimePermissions({ image, command: null }, catalogImages),
        { wrapper },
      ).result;

    const useOnly = read("example.com/own:v1");
    await waitFor(() => expect(useOnly.current.canChange).toBeDefined());
    expect(useOnly.current).toEqual({
      canChange: true,
      canConfigure: false,
      readOnlyBy: "Team runtime",
      accounts: null,
    });
    // An image none of the runtimes owns needs configure rights on all.
    expect(read("example.com/other:v1").current).toEqual({
      canChange: false,
      canConfigure: false,
      readOnlyBy: null,
      accounts: null,
    });

    sdk.listAgentRuntimeAccess.mockResolvedValue({
      data: {
        runtimes: [{ id: customId, canUse: true, canConfigure: true }],
        canConfigureAny: true,
      },
      error: undefined,
    } as never);
    await queryClient.invalidateQueries();
    const configure = read("example.com/own:v1");
    await waitFor(() => expect(configure.current.canConfigure).toBe(true));
    expect(configure.current).toEqual({
      canChange: true,
      canConfigure: true,
      readOnlyBy: null,
      accounts: null,
    });
    queryClient.clear();
  });

  it("gives a runtime's account rule, with the names the server filled in", async () => {
    // A custom runtime carries them in the catalog, beside its image.
    const fixed = {
      llmApiKeyId: "key-1",
      modelId: "model-1",
      keyName: "Company OpenAI",
      keyProvider: "openai",
      modelName: "GPT-5",
    };
    sdk.listAgentRuntimeTemplates.mockResolvedValue({
      data: [
        {
          id: customId,
          name: "Team runtime",
          image: "example.com/own:v1",
          accounts: fixed,
        },
      ],
      error: undefined,
    } as never);
    sdk.listAgentRuntimeAccess.mockResolvedValue({
      data: {
        runtimes: [
          { id: customId, canUse: true, canConfigure: false },
          { id: "codex", canUse: true, canConfigure: false },
          { id: "opencode", canUse: true, canConfigure: false },
        ],
        canConfigureAny: false,
      },
      error: undefined,
    } as never);
    // A maintained one carries them in its settings, with the kind of
    // account it names where it has two.
    sdk.listBuiltInAgentRuntimeSettings.mockResolvedValue({
      data: [{ id: "codex", settings: { accounts: { kind: "key" } } }],
      error: undefined,
    } as never);
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const read = (image: string, command: string[] | null = null) =>
      renderHook(
        () => useAgentRuntimePermissions({ image, command }, catalogImages),
        { wrapper },
      ).result;

    const custom = read("example.com/own:v1");
    await waitFor(() => expect(custom.current.accounts).toEqual(fixed));

    const codex = read(catalogImages.codex, ["archestra-codex"]);
    // Unknown until its settings have answered: a new agent's start waits.
    expect(codex.current.accounts).toBeUndefined();
    await waitFor(() =>
      expect(codex.current.accounts).toEqual({ kind: "key" }),
    );
    // A runtime with no settings saved fixes nothing and names no kind.
    const opencode = read(catalogImages.opencode, ["archestra-opencode"]);
    await waitFor(() => expect(opencode.current.accounts).toBeNull());
    queryClient.clear();
  });

  it("takes only the rule as what a Claude runtime decides: a Claude account it stores restricts nothing", async () => {
    let customKind: "subscription" | undefined;
    sdk.listAgentRuntimeTemplates.mockImplementation((async () => ({
      data: [
        {
          id: customId,
          name: "Team runtime",
          image: "example.com/own:v1",
          ...(customKind && { accounts: { kind: customKind } }),
        },
      ],
      error: undefined,
    })) as never);
    sdk.listAgentRuntimeAccess.mockResolvedValue({
      data: {
        runtimes: [
          { id: customId, canUse: true, canConfigure: false },
          { id: "claude-code", canUse: true, canConfigure: false },
        ],
        canConfigureAny: false,
      },
      error: undefined,
    } as never);
    // The maintained Claude Code runtime stores a Claude account, as every
    // save of its settings once wrote, and no rule.
    let claudeCodeSettings: {
      claudeCode?: { authentication: "provider" | "subscription" };
      accounts?: { kind: "subscription" | "key" };
    } = { claudeCode: { authentication: "subscription" } };
    sdk.listBuiltInAgentRuntimeSettings.mockImplementation((async () => ({
      data: [{ id: "claude-code", settings: claudeCodeSettings }],
      error: undefined,
    })) as never);
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const read = (image: string) =>
      renderHook(
        () =>
          useAgentRuntimePermissions({ image, command: null }, catalogImages),
        { wrapper },
      ).result;

    const custom = read("example.com/own:v1");
    await waitFor(() => expect(custom.current.accounts).toBeNull());
    expect(custom.current.readOnlyBy).toBe("Team runtime");
    const claudeCode = read(catalogImages["claude-code"]);
    await waitFor(() => expect(claudeCode.current.accounts).toBeNull());
    // A custom runtime's own Claude account is in the runtime itself, which
    // is not read for it: only the catalog's rule counts.
    expect(sdk.getAgentRuntimeTemplate).not.toHaveBeenCalled();

    // The rule's kind is what names an account, on both.
    claudeCodeSettings = {
      claudeCode: { authentication: "provider" },
      accounts: { kind: "key" },
    };
    customKind = "subscription";
    await queryClient.invalidateQueries();
    await waitFor(() =>
      expect(claudeCode.current.accounts).toEqual({ kind: "key" }),
    );
    await waitFor(() =>
      expect(custom.current.accounts).toEqual({ kind: "subscription" }),
    );
    queryClient.clear();
  });
});

describe("useBuiltInRuntimeDefaults", () => {
  afterEach(() => vi.clearAllMocks());

  it("gives a new agent the runtime's defaults, and starts a Claude agent on the kind its rule names", async () => {
    sdk.listBuiltInAgentRuntimeSettings.mockResolvedValue({
      data: [
        {
          id: "claude-code",
          settings: {
            ttlHours: 8,
            accounts: { kind: "key", llmApiKeyId: "runtime-key" },
          },
        },
      ],
      error: undefined,
    } as never);
    const queryClient = new QueryClient();
    const { result } = renderHook(() => useBuiltInRuntimeDefaults(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    });

    await waitFor(() => expect(result.current("claude-code")).toBeDefined());
    const started = withAgentRuntimeDefaults({
      runtime: buildAgentCatalogRuntime({
        id: "claude-code",
        image: catalogImages["claude-code"],
      }),
      defaults: result.current("claude-code"),
    });
    expect(started).toMatchObject({
      ttlHours: 8,
      claudeCode: { authentication: "provider" },
    });
    // The rule is the runtime's own: it is never part of an agent's runtime.
    expect(started).not.toHaveProperty("accounts");
    expect(result.current("codex")).toBeUndefined();
    queryClient.clear();
  });
});
