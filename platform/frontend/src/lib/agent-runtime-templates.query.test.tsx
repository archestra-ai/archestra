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
  useBuiltInRuntimeDefaults,
  useRuntimeAccountRule,
} from "./agent-runtime-templates.query";

vi.mock("@archestra/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archestra/shared")>();
  return {
    ...actual,
    archestraApiSdk: {
      ...actual.archestraApiSdk,
      listAgentRuntimeTemplates: vi.fn(),
      listBuiltInAgentRuntimeSettings: vi.fn(),
    },
  };
});

const sdk = vi.mocked(archestraApiSdk);
const catalogImages = getAgentCatalogImages({
  registry: "mirror.example.com/archestra",
  tag: "1.4.0",
});
const customId = "c0ffee00-0000-4000-8000-000000000001";

function wrapperFor(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("useRuntimeAccountRule", () => {
  afterEach(() => vi.clearAllMocks());

  it("reads a custom runtime's rule from the runtime list, a maintained runtime's from its settings, and none for an image no runtime owns", async () => {
    sdk.listAgentRuntimeTemplates.mockResolvedValue({
      data: [
        {
          id: customId,
          name: "Team runtime",
          image: "example.com/own:v1",
          accounts: { kind: "subscription" },
        },
      ],
      error: undefined,
    } as never);
    sdk.listBuiltInAgentRuntimeSettings.mockResolvedValue({
      data: [
        {
          id: "codex",
          settings: { accounts: { kind: "key", llmApiKeyId: "company-key" } },
        },
      ],
      error: undefined,
    } as never);
    const queryClient = new QueryClient();
    const read = (image: string, command: string[] | null = null) =>
      renderHook(
        () => useRuntimeAccountRule({ image, command }, catalogImages),
        { wrapper: wrapperFor(queryClient) },
      ).result;

    const custom = read("example.com/own:v1");
    const codex = read(catalogImages.codex, ["archestra-codex"]);
    const claudeCode = read(catalogImages["claude-code"]);
    const unowned = read("example.com/other:v1");

    await waitFor(() =>
      expect(custom.current).toEqual({ kind: "subscription" }),
    );
    await waitFor(() =>
      expect(codex.current).toEqual({
        kind: "key",
        llmApiKeyId: "company-key",
      }),
    );
    await waitFor(() => expect(claudeCode.current).toBeNull());
    expect(unowned.current).toBeNull();
    queryClient.clear();
  });
});

describe("useBuiltInRuntimeDefaults", () => {
  afterEach(() => vi.clearAllMocks());

  it("gives a new agent the runtime's defaults, and never its account rule", async () => {
    sdk.listBuiltInAgentRuntimeSettings.mockResolvedValue({
      data: [
        {
          id: "claude-code",
          settings: {
            ttlHours: 8,
            claudeCode: { authentication: "provider" },
            accounts: { kind: "key", llmApiKeyId: "runtime-key" },
          },
        },
      ],
      error: undefined,
    } as never);
    const queryClient = new QueryClient();
    const { result } = renderHook(() => useBuiltInRuntimeDefaults(), {
      wrapper: wrapperFor(queryClient),
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
