// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise

"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCapabilities } from "@/lib/llm-models.query";

// Radix Popper / floating-ui needs ResizeObserver
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Radix Popper needs getBoundingClientRect
Element.prototype.getBoundingClientRect = () => ({
  x: 0,
  y: 0,
  width: 100,
  height: 20,
  top: 0,
  right: 100,
  bottom: 20,
  left: 0,
  toJSON: () => {},
});

// DOMRect polyfill for floating-ui
if (typeof globalThis.DOMRect === "undefined") {
  globalThis.DOMRect = class DOMRect {
    x = 0;
    y = 0;
    width = 0;
    height = 0;
    top = 0;
    right = 0;
    bottom = 0;
    left = 0;
    toJSON() {}
    static fromRect() {
      return new DOMRect();
    }
  } as unknown as typeof globalThis.DOMRect;
}

// Radix Select uses scrollIntoView and pointer capture
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();

// --- Mocks ---

let mockOrganization: Record<string, unknown> | null = null;
let mockOrgPending = false;
let mockUpdateKnowledgeSettings = vi.fn();

vi.mock("@/lib/organization.query");
// The provider key form brands its copy with the deployment's app name, which
// reads appearance settings from the (auto-mocked) organization query above.
vi.mock("@/lib/hooks/use-app-name");

import { useAppName } from "@/lib/hooks/use-app-name";
import {
  useDropEmbeddingConfig,
  useKeywordRankingStatus,
  useOrganization,
  useTestEmbeddingConnection,
  useTestOcrConnection,
  useTestRerankerConnection,
  useUpdateIntegrationSettings,
  useUpdateKnowledgeSettings,
} from "@/lib/organization.query";

let mockApiKeys: Array<{
  id: string;
  name: string;
  provider: string;
  scope: string;
  subscriptionKind?: string | null;
}> = [];
let mockEmbeddingModels: Array<{
  id: string;
  provider: string;
  displayName: string;
  embeddingDimensions: 3072 | 1536 | 768 | null;
  capabilities?: ModelCapabilities;
  embeddingClientImageCapable?: boolean | null;
  isFree?: boolean;
  isBest?: boolean;
}> = [];
let mockLlmModels: Array<{
  id: string;
  provider: string;
  displayName: string;
  capabilities?: ModelCapabilities;
  isFree?: boolean;
  isBest?: boolean;
}> = [];

vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  useAvailableLlmProviderApiKeys: () => ({
    data: mockApiKeys,
    isPending: false,
  }),
  useCreateLlmProviderApiKey: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/lib/llm-models.query", () => ({
  useLlmModels: () => ({
    data: mockLlmModels,
    isPending: false,
  }),
  useEmbeddingModels: () => ({
    data: mockEmbeddingModels,
    isPending: false,
  }),
  useModelsWithApiKeys: () => ({
    data: mockEmbeddingModels.map((m) => ({
      id: m.id,
      modelId: m.id,
      provider: m.provider,
      embeddingDimensions: m.embeddingDimensions,
      inputModalities: m.capabilities?.inputModalities ?? null,
      embeddingClientImageCapable:
        m.embeddingClientImageCapable === undefined
          ? false
          : m.embeddingClientImageCapable,
      apiKeys: mockApiKeys
        .filter((k) => k.provider === m.provider)
        .map((k) => ({ id: k.id })),
    })),
    isPending: false,
  }),
}));

vi.mock("@/lib/config/config.query");

import {
  useEnterpriseFeature,
  useFeature,
  useProviderBaseUrls,
  useSmallTeamTier,
} from "@/lib/config/config.query";

vi.mock("@/lib/team.query", () => ({
  useTeams: () => ({
    data: [],
    isPending: false,
  }),
}));

vi.mock("@/lib/auth/auth.query");

import {
  useHasPermissions,
  useMissingPermissions,
  useSession,
} from "@/lib/auth/auth.query";

vi.mock("@/lib/clients/auth/auth-client");

import { authClient } from "@/lib/clients/auth/auth-client";

// Need to import after mocks are set up
import KnowledgeSettingsPage from "./page";

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <KnowledgeSettingsPage />
    </QueryClientProvider>,
  );
}

function getEmbeddingModelTrigger() {
  const modelTrigger = screen
    .getAllByRole("combobox")
    .find((el) => el.textContent?.includes("Select embedding model"));

  if (!modelTrigger) {
    throw new Error("Embedding model trigger not found");
  }

  return modelTrigger;
}

function getRerankerModelTrigger() {
  const modelTrigger = screen
    .getAllByRole("combobox")
    .find((el) => el.textContent?.includes("Select reranking model"));

  if (!modelTrigger) {
    throw new Error("Reranking model trigger not found");
  }

  return modelTrigger;
}

function makeCapabilities(
  overrides: Partial<ModelCapabilities> = {},
): ModelCapabilities {
  return {
    contextLength: 128000,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsToolCalling: true,
    supportsReasoningEffort: null,
    recommendedForAgents: true,
    pricePerMillionInput: null,
    pricePerMillionOutput: null,
    isCustomPrice: false,
    priceSource: "default",
    pricePerMillionCacheRead: null,
    pricePerMillionCacheWrite: null,
    cachePriceSource: "default",
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(useUpdateIntegrationSettings).mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
  } as unknown as ReturnType<typeof useUpdateIntegrationSettings>);
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(useAppName).mockReturnValue("Archestra");
  mockUpdateKnowledgeSettings = vi.fn();
  mockOrganization = null;
  mockOrgPending = false;
  mockApiKeys = [];
  mockEmbeddingModels = [
    {
      id: "text-embedding-3-small",
      provider: "openai",
      displayName: "text-embedding-3-small",
      embeddingDimensions: 1536,
    },
  ];
  mockLlmModels = [
    { id: "gpt-4o", provider: "openai", displayName: "GPT-4o" },
    {
      id: "claude-3-opus",
      provider: "anthropic",
      displayName: "Claude 3 Opus",
    },
  ];

  vi.mocked(useOrganization).mockImplementation(
    () =>
      ({
        data: mockOrganization,
        isPending: mockOrgPending,
      }) as unknown as ReturnType<typeof useOrganization>,
  );
  vi.mocked(useUpdateKnowledgeSettings).mockImplementation(
    () =>
      ({
        mutateAsync: mockUpdateKnowledgeSettings,
        isPending: false,
      }) as unknown as ReturnType<typeof useUpdateKnowledgeSettings>,
  );
  vi.mocked(useTestEmbeddingConnection).mockReturnValue({
    mutateAsync: vi.fn(),
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useTestEmbeddingConnection>);
  vi.mocked(useTestRerankerConnection).mockReturnValue({
    mutateAsync: vi.fn(),
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useTestRerankerConnection>);
  vi.mocked(useTestOcrConnection).mockReturnValue({
    mutateAsync: vi.fn(),
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useTestOcrConnection>);
  vi.mocked(useDropEmbeddingConfig).mockReturnValue({
    mutateAsync: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useDropEmbeddingConfig>);
  vi.mocked(useKeywordRankingStatus).mockReturnValue({
    data: null,
  } as unknown as ReturnType<typeof useKeywordRankingStatus>);

  vi.mocked(useFeature).mockReturnValue(
    false as unknown as ReturnType<typeof useFeature>,
  );
  vi.mocked(useEnterpriseFeature).mockReturnValue(false);
  vi.mocked(useSmallTeamTier).mockReturnValue(undefined);
  vi.mocked(useProviderBaseUrls).mockReturnValue({
    data: {},
  } as unknown as ReturnType<typeof useProviderBaseUrls>);

  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
    isPending: false,
  } as ReturnType<typeof useHasPermissions>);
  vi.mocked(useMissingPermissions).mockReturnValue(
    [] as unknown as ReturnType<typeof useMissingPermissions>,
  );
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "test-user" } },
  } as ReturnType<typeof useSession>);

  vi.mocked(authClient.useSession).mockReturnValue({
    data: {
      user: { id: "test-user", email: "test@example.com" },
      session: { id: "test-session" },
    },
  } as unknown as ReturnType<typeof authClient.useSession>);
});

describe("KnowledgeSettingsPage", () => {
  describe("small team tier notice", () => {
    /**
     * The licence gates team-scoped connector visibility and auto-sync
     * permissions — not Knowledge as a whole. Creating knowledge bases,
     * indexing and retrieval keep working above the threshold, so the notice
     * must not tell an operator the feature has been switched off.
     */
    it("names the gated capabilities rather than declaring Knowledge disabled", () => {
      vi.mocked(useSmallTeamTier).mockReturnValue({
        communicate: true,
        smallTeam: false,
        envFlag: false,
        userCount: 42,
        threshold: 30,
      } as ReturnType<typeof useSmallTeamTier>);
      renderPage();

      expect(
        screen.getByText(
          /Enterprise features \(RBAC, SSO, Knowledge Base with access control\) are disabled until a license is activated\./,
        ),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/Knowledge is an enterprise feature/),
      ).not.toBeInTheDocument();
    });
  });

  describe("embedding model placeholder", () => {
    it("shows placeholder text when no embedding key is configured (not the database default)", () => {
      mockOrganization = {
        embeddingChatApiKeyId: null,
        embeddingModel: "text-embedding-3-small", // database default, but no key
        rerankerChatApiKeyId: null,
        rerankerModel: null,
      };
      renderPage();

      // Should show placeholder, not the database default model
      expect(
        screen.getAllByText("Select embedding model...").length,
      ).toBeGreaterThan(0);
    });

    it("shows selected model when embedding key is configured", () => {
      mockOrganization = {
        embeddingChatApiKeyId: "key-1",
        embeddingModel: "text-embedding-3-large",
        rerankerChatApiKeyId: null,
        rerankerModel: null,
      };
      mockApiKeys = [
        {
          id: "key-1",
          name: "OpenAI Key",
          provider: "openai",
          scope: "org",
        },
      ];
      renderPage();

      expect(screen.getByText("text-embedding-3-large")).toBeInTheDocument();
    });

    it("shows the configured embedding dimensions as a chip on the selected model", () => {
      mockOrganization = {
        embeddingChatApiKeyId: "key-1",
        embeddingModel: "gemini-embedding-001",
        rerankerChatApiKeyId: null,
        rerankerModel: null,
      };
      mockApiKeys = [
        {
          id: "key-1",
          name: "Vertex AI",
          provider: "gemini",
          scope: "org",
        },
      ];
      mockEmbeddingModels = [
        {
          id: "gemini-embedding-001",
          provider: "gemini",
          displayName: "gemini-embedding-001",
          embeddingDimensions: 1536,
        },
      ];
      renderPage();

      expect(screen.getByText("1536 dims")).toBeInTheDocument();
    });

    it("shows embedding model descriptions in the dropdown", async () => {
      const user = userEvent.setup();

      mockOrganization = {
        embeddingChatApiKeyId: "key-1",
        embeddingModel: null,
        rerankerChatApiKeyId: null,
        rerankerModel: null,
      };
      mockApiKeys = [
        {
          id: "key-1",
          name: "OpenAI Key",
          provider: "openai",
          scope: "org",
        },
      ];
      renderPage();

      await user.click(getEmbeddingModelTrigger());

      expect(
        screen.getAllByText("text-embedding-3-small").length,
      ).toBeGreaterThanOrEqual(1);
    });

    it("preserves a previously saved embedding model even if it is no longer detected", () => {
      mockOrganization = {
        embeddingChatApiKeyId: "key-1",
        embeddingModel: "legacy-embedding-model",
        rerankerChatApiKeyId: null,
        rerankerModel: null,
      };
      mockApiKeys = [
        {
          id: "key-1",
          name: "OpenAI Key",
          provider: "openai",
          scope: "org",
        },
      ];
      mockEmbeddingModels = [];
      renderPage();

      expect(screen.getByText("legacy-embedding-model")).toBeInTheDocument();
    });

    it("shows a helpful empty state when the selected key has no embedding models", async () => {
      const user = userEvent.setup();

      mockOrganization = {
        embeddingChatApiKeyId: "key-1",
        embeddingModel: null,
        rerankerChatApiKeyId: null,
        rerankerModel: null,
      };
      mockApiKeys = [
        {
          id: "key-1",
          name: "Vertex AI",
          provider: "gemini",
          scope: "org",
        },
      ];
      mockEmbeddingModels = [];
      renderPage();

      await user.click(getEmbeddingModelTrigger());

      expect(
        screen.getByText('No embedding models detected for "Vertex AI".'),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("link", {
          name: /Sync models and configure embedding dimensions/,
        }),
      ).toHaveAttribute("href", "/llm/models");
    });
  });

  describe("model capability metadata", () => {
    it("shows embedding model modalities and context in the dropdown", async () => {
      const user = userEvent.setup();
      mockOrganization = {
        embeddingChatApiKeyId: "key-1",
        embeddingModel: null,
        rerankerChatApiKeyId: null,
        rerankerModel: null,
      };
      mockApiKeys = [
        {
          id: "key-1",
          name: "Embedding Key",
          provider: "openai",
          scope: "org",
        },
      ];
      mockEmbeddingModels = [
        {
          id: "multimodal-embedding",
          provider: "openai",
          displayName: "Multimodal Embedding",
          embeddingDimensions: 1536,
          capabilities: makeCapabilities({
            inputModalities: ["text", "image"],
          }),
          embeddingClientImageCapable: true,
        },
      ];
      renderPage();

      await user.click(getEmbeddingModelTrigger());

      expect(screen.getByLabelText("Supports text input")).toBeInTheDocument();
      expect(
        screen.getByLabelText("Supports vision (images)"),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText("128,000 token context window"),
      ).toBeInTheDocument();
    });

    it("shows reranking model modalities and capabilities in the dropdown", async () => {
      const user = userEvent.setup();
      mockOrganization = {
        embeddingChatApiKeyId: null,
        embeddingModel: null,
        rerankerChatApiKeyId: "key-1",
        rerankerModel: null,
      };
      mockApiKeys = [
        {
          id: "key-1",
          name: "Reranking Key",
          provider: "openai",
          scope: "org",
        },
      ];
      mockLlmModels = [
        {
          id: "vision-reranker",
          provider: "openai",
          displayName: "Vision Reranker",
          capabilities: makeCapabilities({
            inputModalities: ["text", "image"],
            supportsToolCalling: true,
          }),
        },
      ];
      renderPage();

      await user.click(getRerankerModelTrigger());

      expect(screen.getByLabelText("Supports text input")).toBeInTheDocument();
      expect(
        screen.getByLabelText("Supports vision (images)"),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText("Supports tool calling"),
      ).toBeInTheDocument();
    });
  });

  describe("embedding image support note", () => {
    it("shows a dismissible note inside the embedding settings card", async () => {
      const user = userEvent.setup();
      mockOrganization = {
        id: "organization-1",
        embeddingChatApiKeyId: "key-1",
        embeddingModel: "text-embedding-model",
        rerankerChatApiKeyId: null,
        rerankerModel: null,
      };
      mockApiKeys = [
        {
          id: "key-1",
          name: "Embedding Key",
          provider: "openai",
          scope: "org",
        },
      ];
      mockEmbeddingModels = [
        {
          id: "text-embedding-model",
          provider: "openai",
          displayName: "Text Embedding Model",
          embeddingDimensions: 1536,
          capabilities: makeCapabilities({
            inputModalities: ["text"],
            supportsToolCalling: null,
          }),
          embeddingClientImageCapable: false,
        },
      ];
      renderPage();

      const note = await screen.findByRole("note");
      expect(note.closest("#embedding-configuration")).toBeInTheDocument();
      expect(
        within(note).queryByRole("link", { name: "Embedding settings" }),
      ).not.toBeInTheDocument();
      expect(
        within(note).getByRole("link", { name: "Learn more" }),
      ).toBeInTheDocument();

      await user.click(within(note).getByRole("button", { name: "Dismiss" }));
      expect(screen.queryByRole("note")).not.toBeInTheDocument();
    });

    it("does not show the note for an image-capable embedding model", () => {
      mockOrganization = {
        id: "organization-1",
        embeddingChatApiKeyId: "key-1",
        embeddingModel: "multimodal-embedding",
        rerankerChatApiKeyId: null,
        rerankerModel: null,
      };
      mockApiKeys = [
        {
          id: "key-1",
          name: "Embedding Key",
          provider: "openai",
          scope: "org",
        },
      ];
      mockEmbeddingModels = [
        {
          id: "multimodal-embedding",
          provider: "openai",
          displayName: "Multimodal Embedding",
          embeddingDimensions: 1536,
          capabilities: makeCapabilities({
            inputModalities: ["text", "image"],
          }),
          embeddingClientImageCapable: true,
        },
      ];
      renderPage();

      expect(screen.queryByRole("note")).not.toBeInTheDocument();
    });
  });

  describe("embedding model locking", () => {
    it("shows lock message when both key and model have been saved", () => {
      mockOrganization = {
        embeddingChatApiKeyId: "key-1",
        embeddingModel: "text-embedding-3-small",
        rerankerChatApiKeyId: null,
        rerankerModel: null,
      };
      mockApiKeys = [
        {
          id: "key-1",
          name: "OpenAI Key",
          provider: "openai",
          scope: "org",
        },
      ];
      renderPage();

      expect(screen.getByText("Embedding index locked")).toBeInTheDocument();
      expect(
        screen.getByText(/Drop the index to change models/),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Drop index" }),
      ).toBeInTheDocument();
    });

    it("shows lock message when model is locked", () => {
      mockOrganization = {
        embeddingChatApiKeyId: "key-1",
        embeddingModel: "text-embedding-3-small",
        rerankerChatApiKeyId: null,
        rerankerModel: null,
      };
      mockApiKeys = [
        {
          id: "key-1",
          name: "OpenAI Key",
          provider: "openai",
          scope: "org",
        },
      ];
      renderPage();

      expect(screen.getByText("Embedding index locked")).toBeInTheDocument();
    });

    it("does not show lock message when key or model is missing", () => {
      mockOrganization = {
        embeddingChatApiKeyId: null,
        embeddingModel: null,
        rerankerChatApiKeyId: null,
        rerankerModel: null,
      };
      renderPage();

      expect(
        screen.queryByText("Embedding index locked"),
      ).not.toBeInTheDocument();
    });

    it("disables the embedding API key selector when embedding config is locked", () => {
      mockOrganization = {
        embeddingChatApiKeyId: "key-1",
        embeddingModel: "text-embedding-3-small",
        rerankerChatApiKeyId: null,
        rerankerModel: null,
      };
      mockApiKeys = [
        {
          id: "key-1",
          name: "OpenAI Key",
          provider: "openai",
          scope: "org",
        },
      ];

      renderPage();

      const embeddingKeyTrigger = screen.getByRole("button", {
        name: /OpenAI Key/,
      });
      expect(embeddingKeyTrigger).toBeDisabled();
    });
  });

  describe("setup step highlight", () => {
    it("highlights Add LLM Provider Key button when no OpenAI keys exist", () => {
      mockOrganization = {
        embeddingChatApiKeyId: null,
        embeddingModel: null,
        rerankerChatApiKeyId: null,
        rerankerModel: null,
      };
      mockApiKeys = []; // no keys at all
      renderPage();

      const addButtons = screen.getAllByRole("button", {
        name: /Add LLM Provider Key/,
      });
      // First Add button is the embedding one
      expect(addButtons[0].className).toContain("ring-primary/50");
      expect(addButtons[0].className).not.toContain("animate-pulse");
    });

    it("highlights key selector dropdown when OpenAI keys exist but none selected", () => {
      mockOrganization = {
        embeddingChatApiKeyId: null,
        embeddingModel: null,
        rerankerChatApiKeyId: null,
        rerankerModel: null,
      };
      mockApiKeys = [
        {
          id: "key-1",
          name: "OpenAI Key",
          provider: "openai",
          scope: "org",
        },
      ];
      renderPage();

      const embeddingKeyTrigger = screen.getByRole("button", {
        name: /Select embedding API key/,
      });
      expect(embeddingKeyTrigger.className).toContain("ring-primary/50");
      expect(embeddingKeyTrigger.className).not.toContain("animate-pulse");
    });

    it("highlights model dropdown when key selected but model not selected", () => {
      mockOrganization = {
        embeddingChatApiKeyId: "key-1",
        embeddingModel: null,
        rerankerChatApiKeyId: null,
        rerankerModel: null,
      };
      mockApiKeys = [
        {
          id: "key-1",
          name: "OpenAI Key",
          provider: "openai",
          scope: "org",
        },
      ];
      renderPage();

      // The embedding model dropdown trigger should have pulse classes
      const modelTrigger = screen
        .getAllByRole("combobox")
        .find((el) => el.textContent?.includes("Select embedding model"));
      expect(modelTrigger).toBeDefined();
      expect(modelTrigger?.className).toContain("ring-primary/50");
      expect(modelTrigger?.className).not.toContain("animate-pulse");
    });

    it("does not highlight anything when embedding is fully configured", () => {
      mockOrganization = {
        embeddingChatApiKeyId: "key-1",
        embeddingModel: "text-embedding-3-small",
        embeddingDimensions: 1536,
        rerankerChatApiKeyId: "key-1",
        rerankerModel: "gpt-4o",
      };
      mockApiKeys = [
        {
          id: "key-1",
          name: "OpenAI Key",
          provider: "openai",
          scope: "org",
        },
      ];
      renderPage();

      // No element should carry the setup-step highlight ring.
      const highlighted = document.querySelectorAll(
        '[class*="ring-primary/50"]',
      );
      expect(highlighted.length).toBe(0);
    });
  });

  describe("embedding api key dialog", () => {
    it("shows provider options for adding an embedding API key", () => {
      mockOrganization = {
        embeddingChatApiKeyId: null,
        embeddingModel: null,
        rerankerChatApiKeyId: null,
        rerankerModel: null,
      };

      renderPage();

      const addButtons = screen.getAllByRole("button", {
        name: /Add LLM Provider Key/,
      });
      fireEvent.click(addButtons[0]);

      const providerTrigger = screen.getByRole("combobox", {
        name: /Provider/i,
      });
      fireEvent.click(providerTrigger);

      // Anchored, because an unanchored substring is ambiguous: "Ollama
      // (OpenAI-compatible)" contains "OpenAI", as does the OpenAI-compatible
      // entry itself — hence the negative lookahead for the hyphen. The
      // accessible name repeats the label (the option renders an icon whose alt
      // text is the provider name), so an exact string will not match either.
      expect(
        screen.getByRole("button", { name: /^OpenAI(?!-)/ }),
      ).toBeEnabled();
      // The two Ollama transports collapse to one "Ollama" entry. Embeddings
      // only work over `/v1`, so this entry must resolve to that transport —
      // collapsing to `ollama-native` (which reports supportsEmbeddings: false)
      // would render it disabled and leave no way to add an Ollama embedding key.
      expect(screen.getByRole("button", { name: /^Ollama\b/ })).toBeEnabled();
      expect(screen.getByRole("button", { name: /Anthropic/i })).toBeEnabled();
      expect(screen.getByRole("button", { name: /Gemini/i })).toBeEnabled();
    });
  });

  describe("reranking section", () => {
    it("shows reranking configuration section", () => {
      mockOrganization = {
        embeddingChatApiKeyId: null,
        embeddingModel: null,
        rerankerChatApiKeyId: null,
        rerankerModel: null,
      };
      renderPage();

      expect(
        screen.getByText("Search Ranking Configuration"),
      ).toBeInTheDocument();
    });

    it("saves per-passage context generation independently", async () => {
      const user = userEvent.setup();
      mockOrganization = {
        embeddingChatApiKeyId: null,
        embeddingModel: null,
        rerankerChatApiKeyId: null,
        rerankerModel: null,
        kbContextualRetrievalMode: "document",
      };
      renderPage();

      const mode = screen.getByRole("combobox", {
        name: "Context generation",
      });
      expect(mode).toHaveTextContent("Per document — lower cost");
      await user.click(mode);
      await user.click(
        screen.getByRole("option", { name: "Per passage — higher recall" }),
      );
      await user.click(screen.getByRole("button", { name: "Save" }));

      expect(mockUpdateKnowledgeSettings).toHaveBeenCalledWith({
        kbContextualRetrievalMode: "chunk",
        kbBm25K1: null,
        kbBm25B: null,
      });
    });

    it("shows the deployment default without creating an organization override", () => {
      mockOrganization = {
        embeddingChatApiKeyId: null,
        embeddingModel: null,
        rerankerChatApiKeyId: null,
        rerankerModel: null,
        kbContextualRetrievalMode: null,
      };
      vi.mocked(useFeature).mockImplementation(((flag: string) =>
        flag === "kbContextualRetrievalDefaultMode"
          ? "document"
          : false) as unknown as typeof useFeature);
      renderPage();

      expect(
        screen.getByRole("combobox", { name: "Context generation" }),
      ).toHaveTextContent("Per document — lower cost");
      expect(
        screen.queryByRole("button", { name: "Save" }),
      ).not.toBeInTheDocument();
    });

    it("shows 'Select a reranker API key first...' when no key selected", () => {
      mockOrganization = {
        embeddingChatApiKeyId: null,
        embeddingModel: null,
        rerankerChatApiKeyId: null,
        rerankerModel: null,
      };
      mockApiKeys = [
        {
          id: "key-1",
          name: "OpenAI Key",
          provider: "openai",
          scope: "org",
        },
      ];
      renderPage();

      expect(
        screen.getByText("Select a reranker API key first..."),
      ).toBeInTheDocument();
    });

    it("allows clearing reranking configuration", async () => {
      const user = userEvent.setup();

      mockOrganization = {
        embeddingChatApiKeyId: null,
        embeddingModel: null,
        rerankerChatApiKeyId: "key-1",
        rerankerModel: "gpt-4o",
      };
      mockApiKeys = [
        {
          id: "key-1",
          name: "OpenAI Key",
          provider: "openai",
          scope: "org",
        },
      ];
      renderPage();

      await user.click(
        screen.getByRole("button", {
          name: "Clear reranking configuration",
        }),
      );
      await user.click(screen.getByRole("button", { name: "Save" }));

      // The cleared section, and nothing the admin did not touch: the backend
      // re-exercises every section the payload mentions with a real model
      // call, so an untouched OCR pair must not ride along.
      expect(mockUpdateKnowledgeSettings).toHaveBeenCalledWith({
        rerankerChatApiKeyId: null,
        rerankerModel: null,
        kbBm25K1: null,
        kbBm25B: null,
      });
    });

    it("shows the Document OCR card and saves a cleared OCR configuration", async () => {
      const user = userEvent.setup();

      mockOrganization = {
        embeddingChatApiKeyId: null,
        embeddingModel: null,
        rerankerChatApiKeyId: null,
        rerankerModel: null,
        ocrChatApiKeyId: "key-1",
        ocrModel: "claude-sonnet-5",
      };
      mockApiKeys = [
        {
          id: "key-1",
          name: "Anthropic Key",
          provider: "anthropic",
          scope: "org",
        },
      ];
      renderPage();

      expect(screen.getByText("Document OCR")).toBeInTheDocument();
      await user.click(
        screen.getByRole("button", { name: "Clear OCR configuration" }),
      );
      await user.click(screen.getByRole("button", { name: "Save" }));

      expect(mockUpdateKnowledgeSettings).toHaveBeenCalledWith({
        ocrChatApiKeyId: null,
        ocrModel: null,
        kbBm25K1: null,
        kbBm25B: null,
      });
    });

    it("does not offer personal subscriptions for organization reranking", async () => {
      const user = userEvent.setup();
      mockOrganization = {
        embeddingChatApiKeyId: null,
        embeddingModel: null,
        rerankerChatApiKeyId: "key-1",
        rerankerModel: "gpt-4o",
      };
      mockApiKeys = [
        {
          id: "key-1",
          name: "OpenAI Key",
          provider: "openai",
          scope: "org",
        },
        {
          id: "chatgpt-subscription",
          name: "ChatGPT Subscription",
          provider: "openai",
          scope: "personal",
          subscriptionKind: "chatgpt",
        },
      ];
      renderPage();

      const rerankingSection = screen
        .getByText("Search Ranking Configuration")
        .closest("section");
      expect(rerankingSection).not.toBeNull();
      await user.click(
        within(rerankingSection as HTMLElement).getByRole("button", {
          name: /OpenAI Key/i,
        }),
      );

      expect(
        screen.queryByRole("option", { name: /ChatGPT Subscription/i }),
      ).not.toBeInTheDocument();
    });

    it("does not offer a SuperGrok credential while still offering a plain xAI key", async () => {
      const user = userEvent.setup();
      mockOrganization = {
        embeddingChatApiKeyId: null,
        embeddingModel: null,
        rerankerChatApiKeyId: "xai-key",
        rerankerModel: "gpt-4o",
      };
      mockApiKeys = [
        {
          id: "xai-key",
          name: "xAI Console Key",
          provider: "xai",
          scope: "org",
        },
        {
          id: "x-premium-key",
          name: "SuperGrok",
          provider: "xai",
          scope: "personal",
          subscriptionKind: "x-premium",
        },
      ];
      renderPage();

      const rerankingSection = screen
        .getByText("Search Ranking Configuration")
        .closest("section");
      expect(rerankingSection).not.toBeNull();
      await user.click(
        within(rerankingSection as HTMLElement).getByRole("button", {
          name: /xAI Console Key/i,
        }),
      );

      expect(
        screen.getByRole("option", { name: /xAI Console Key/i }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("option", { name: /SuperGrok/i }),
      ).not.toBeInTheDocument();
    });
  });

  describe("loading state", () => {
    it("shows loading spinner while organization is loading", () => {
      mockOrgPending = true;
      renderPage();

      // Loading spinner should be present
      expect(
        screen.queryByText("Embedding Configuration"),
      ).not.toBeInTheDocument();
    });
  });

  describe("keyword ranking section", () => {
    const baseOrg = {
      embeddingChatApiKeyId: null,
      embeddingModel: null,
      rerankerChatApiKeyId: null,
      rerankerModel: null,
      ocrChatApiKeyId: null,
      ocrModel: null,
    };
    // Deliberately NOT the shared BM25_*_DEFAULT constants: with those, a page
    // that ignored the deployment config entirely and hard-coded the fallbacks
    // would pass every assertion below.
    const DEPLOYMENT_K1 = 0.9;
    const DEPLOYMENT_B = 0.4;
    const mockFeatures = () =>
      vi.mocked(useFeature).mockImplementation(((flag: string) => {
        if (flag === "kbBm25DefaultK1") return DEPLOYMENT_K1;
        if (flag === "kbBm25DefaultB") return DEPLOYMENT_B;
        return false;
      }) as unknown as typeof useFeature);
    it("shows the BM25 factors — a saved override and the deployment default — as plain values", () => {
      mockOrganization = { ...baseOrg, kbBm25K1: 1.5, kbBm25B: null };
      mockFeatures();
      renderPage();

      expect(
        screen.getByText("Search Ranking Configuration"),
      ).toBeInTheDocument();
      expect(screen.getByText("Keyword ranking")).toBeInTheDocument();
      const k1 = screen.getByLabelText("Term Saturation") as HTMLInputElement;
      const b = screen.getByLabelText(
        "Length Normalization",
      ) as HTMLInputElement;
      expect(k1.value).toBe("1.5");
      // Unset follows this deployment's default, shown like any other value.
      expect(b.value).toBe("0.4");
      // Nothing to save until something differs from what is in effect.
      expect(
        screen.queryByRole("button", { name: "Save" }),
      ).not.toBeInTheDocument();
    });

    it("shows where keyword ranking stands: ready, still building, and a failed update", () => {
      mockOrganization = { ...baseOrg, kbBm25K1: null, kbBm25B: null };
      mockFeatures();
      const mockStatus = (status: Record<string, unknown>) =>
        vi.mocked(useKeywordRankingStatus).mockReturnValue({
          data: {
            lastRefreshedAt: null,
            nextRefreshAt: null,
            refreshing: false,
            lastRefreshFailed: false,
            ...status,
          },
        } as unknown as ReturnType<typeof useKeywordRankingStatus>);

      mockStatus({
        status: "ready",
        lastRefreshedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      });
      const { unmount: unmountReady } = renderPage();
      // On the heading line, right of the subsection title.
      const heading = screen.getByRole("heading", { name: "Keyword ranking" });
      expect(heading.parentElement).toHaveTextContent(
        /Ready · statistics refreshed 5 minutes ago/,
      );
      unmountReady();

      mockStatus({
        status: "pending",
        nextRefreshAt: new Date(Date.now() + 40 * 60_000).toISOString(),
      });
      const { unmount: unmountPending } = renderPage();
      expect(screen.getByText("Building statistics")).toBeInTheDocument();
      expect(screen.getByText(/ready in 40 minutes/)).toBeInTheDocument();
      // The consequence moved to the hover detail to keep the line glanceable.
      expect(
        screen.getByTitle(/rank with PostgreSQL's built-in ranking/),
      ).toBeInTheDocument();
      unmountPending();

      mockStatus({
        status: "pending",
        refreshing: true,
      });
      const { unmount: unmountRefreshing } = renderPage();
      expect(screen.getByText("Updating statistics…")).toBeInTheDocument();
      unmountRefreshing();

      mockStatus({
        status: "pending",
        lastRefreshFailed: true,
        nextRefreshAt: new Date(Date.now() + 60_000).toISOString(),
      });
      renderPage();
      expect(screen.getByText("Statistics update failed")).toBeInTheDocument();
      expect(screen.getByText(/retrying in 1 minute/)).toBeInTheDocument();
      // A flag, never the raw database error: one rebuild covers every
      // organization, so its message can describe another tenant's corpus.
      expect(
        screen.getByTitle(/last rebuild of the ranking statistics/i),
      ).toBeInTheDocument();
    });

    it("tells an organization with nothing indexed that statistics build after the first sync", () => {
      mockOrganization = { ...baseOrg, kbBm25K1: null, kbBm25B: null };
      mockFeatures();
      vi.mocked(useKeywordRankingStatus).mockReturnValue({
        data: {
          status: "no_documents",
          lastRefreshedAt: null,
          nextRefreshAt: null,
          refreshing: false,
          lastRefreshFailed: false,
        },
      } as unknown as ReturnType<typeof useKeywordRankingStatus>);
      renderPage();

      expect(screen.getByText("No documents indexed yet")).toBeInTheDocument();
      expect(
        screen.getByTitle(/statistics build after the first sync/i),
      ).toBeInTheDocument();
    });

    it("sends only the factors when nothing else was touched", async () => {
      const user = userEvent.setup();
      mockOrganization = {
        ...baseOrg,
        embeddingChatApiKeyId: "key-1",
        embeddingModel: "text-embedding-3-small",
        rerankerChatApiKeyId: "key-1",
        rerankerModel: "gpt-4o",
        ocrChatApiKeyId: "key-1",
        ocrModel: "gpt-4o",
        kbBm25K1: null,
        kbBm25B: null,
      };
      mockFeatures();
      renderPage();

      fireEvent.change(screen.getByLabelText("Term Saturation"), {
        target: { value: "1.6" },
      });
      await user.click(screen.getByRole("button", { name: "Save" }));

      // Naming a section makes the backend exercise it with a real model call.
      // A factor edit must not bill an embedding, a reranker and an OCR probe,
      // nor let a section the admin never opened fail this save.
      const payload = mockUpdateKnowledgeSettings.mock.calls[0][0];
      expect(payload).toEqual({ kbBm25K1: 1.6, kbBm25B: null });
    });

    it("keeps a factor edit through a refetch that does not change the saved factors", async () => {
      mockOrganization = { ...baseOrg, kbBm25K1: null, kbBm25B: null };
      mockFeatures();
      renderPage();

      fireEvent.change(screen.getByLabelText("Term Saturation"), {
        target: { value: "1.6" },
      });
      // Another section of this page (Available connectors) writes the
      // organization into the query cache when it saves, handing this form a
      // fresh object. With the saved factors unchanged, it must not discard
      // what is being typed here.
      mockOrganization = { ...baseOrg, kbBm25K1: null, kbBm25B: null };
      fireEvent.change(screen.getByLabelText("Length Normalization"), {
        target: { value: "0.5" },
      });

      expect(
        (screen.getByLabelText("Term Saturation") as HTMLInputElement).value,
      ).toBe("1.6");
    });

    it("says a late rebuild is due shortly rather than in the past", () => {
      mockOrganization = { ...baseOrg, kbBm25K1: null, kbBm25B: null };
      mockFeatures();
      vi.mocked(useKeywordRankingStatus).mockReturnValue({
        data: {
          status: "pending",
          lastRefreshedAt: null,
          // A backed-up queue leaves the due time behind. Rendering the raw
          // distance would read "ready less than a minute ago" — the opposite
          // of what the line says.
          nextRefreshAt: new Date(Date.now() - 12 * 60_000).toISOString(),
          refreshing: false,
          lastRefreshFailed: false,
        },
      } as unknown as ReturnType<typeof useKeywordRankingStatus>);
      renderPage();

      expect(screen.getByText(/ready shortly/)).toBeInTheDocument();
      expect(screen.queryByText(/ago/)).not.toBeInTheDocument();
    });

    it("keeps the factors read-only without knowledgeSettings:update", () => {
      mockOrganization = { ...baseOrg, kbBm25K1: null, kbBm25B: null };
      mockFeatures();
      vi.mocked(useHasPermissions).mockReturnValue({
        data: false,
        isPending: false,
      } as ReturnType<typeof useHasPermissions>);
      renderPage();

      // The status line still reports where ranking stands — that only needs
      // knowledgeSettings:read — but neither factor can be edited.
      expect(screen.getByLabelText("Term Saturation")).toBeDisabled();
      expect(screen.getByLabelText("Length Normalization")).toBeDisabled();
    });

    it("orders ranking sections and links each one to its matching docs", () => {
      mockOrganization = { ...baseOrg, kbBm25K1: null, kbBm25B: null };
      mockFeatures();
      renderPage();

      expect(
        screen
          .getAllByRole("heading", { level: 4 })
          .map((heading) => heading.textContent),
      ).toEqual(["Reranking", "Keyword ranking", "Contextual retrieval"]);

      const links = screen.getAllByRole("link", { name: /Learn more/ });
      expect(links.map((link) => link.getAttribute("href"))).toEqual([
        "https://archestra.ai/docs/platform-knowledge#reranking",
        "https://archestra.ai/docs/platform-knowledge#keyword-ranking",
        "https://archestra.ai/docs/platform-knowledge#contextual-retrieval",
      ]);
    });

    it("saves an edited factor, and a factor set back to the default as null (inherit)", async () => {
      const user = userEvent.setup();
      mockOrganization = { ...baseOrg, kbBm25K1: 1.5, kbBm25B: 0.3 };
      mockFeatures();
      mockUpdateKnowledgeSettings = vi.fn().mockResolvedValue({});
      renderPage();

      const k1 = screen.getByLabelText("Term Saturation");
      const b = screen.getByLabelText("Length Normalization");
      fireEvent.change(k1, { target: { value: "2" } });
      // Typing the default value clears the override rather than pinning it.
      fireEvent.change(b, { target: { value: "0.4" } });

      await user.click(screen.getByRole("button", { name: "Save" }));

      expect(mockUpdateKnowledgeSettings).toHaveBeenCalledWith(
        expect.objectContaining({ kbBm25K1: 2, kbBm25B: null }),
      );
    });

    it("restores the saved value when an emptied factor is left empty", async () => {
      const user = userEvent.setup();
      mockOrganization = { ...baseOrg, kbBm25K1: 1.5, kbBm25B: null };
      mockFeatures();
      renderPage();

      const k1 = screen.getByLabelText("Term Saturation") as HTMLInputElement;
      await user.clear(k1);
      expect(k1.value).toBe("");
      await user.click(screen.getByLabelText("Length Normalization"));

      // The saved override, NOT the deployment default: clearing a field is an
      // editing state, and refilling it with 1.2 would arm a save that quietly
      // discards the 1.5 the organization is running on.
      expect(k1.value).toBe("1.5");
      expect(
        screen.queryByRole("button", { name: "Save" }),
      ).not.toBeInTheDocument();
    });
  });
});
