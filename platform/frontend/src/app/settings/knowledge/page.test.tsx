// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise

"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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

let mockEvaluationRuns: Array<Record<string, unknown>> = [];
let mockRunDetailOverride: Record<string, unknown> | null = null;
let mockEvaluationComparison: Record<string, unknown> | null = null;
let mockCapabilitiesError = false;
let mockPreviewConfiguredModels = false;
let mockRunsError = false;
let mockRunError = false;
let mockComparisonError = false;
const mockStartEvaluation = vi.fn();
const mockCancelEvaluation = vi.fn();
const mockTestEmbeddingConnection = vi.fn();
const mockTestRerankerConnection = vi.fn();
const mockTestOcrConnection = vi.fn();
const mockCapabilitiesRefetch = vi.fn();
const mockRunsRefetch = vi.fn();
const mockRunRefetch = vi.fn();
const mockComparisonRefetch = vi.fn();

vi.mock("@/lib/retrieval-evaluation.query", () => {
  const useCapabilities = () => ({
    data: {
      corpusDigest: "corpus-digest",
      goldenDigest: "golden-digest",
      totalQueries: 20,
      applicableQueries: 4,
      capabilities: {
        "text-embedding": { status: "active", detail: "configured" },
        "image-embedding": { status: "disabled", detail: "text-only" },
        ocr: { status: "disabled", detail: "not configured" },
        "hybrid-search": { status: "active", detail: "enabled" },
        bm25: { status: "active", detail: "verified during run" },
      },
      components: [
        {
          id: "chunking",
          label: "Chunking",
          description: "Checks the production document splitter.",
          mode: "offline",
          status: "active",
          detail: "Ready to evaluate",
          currentFingerprint: "chunking-fingerprint",
          selectedByDefault: true,
          changedSinceLastEvaluation: true,
          lastEvaluatedAt: null,
          lastRunId: null,
          scenarioIds: [],
        },
        {
          id: "text-embedding",
          label: "Text embedding",
          description: "Tests vector retrieval.",
          mode: "online",
          status: "active",
          detail: "Ready to evaluate",
          currentFingerprint: "embedding-fingerprint",
          selectedByDefault: true,
          changedSinceLastEvaluation: true,
          lastEvaluatedAt: null,
          lastRunId: null,
          scenarioIds: ["text-semantic"],
        },
        {
          id: "image-embedding",
          label: "Image embedding",
          description: "Tests multimodal retrieval.",
          mode: "online",
          status: "disabled",
          detail: "Choose an embedding model that accepts images.",
          currentFingerprint: "image-fingerprint",
          selectedByDefault: false,
          changedSinceLastEvaluation: true,
          lastEvaluatedAt: null,
          lastRunId: null,
          scenarioIds: ["multimodal-image"],
        },
        {
          id: "keyword-ranking",
          label: "Keyword ranking",
          description: "Tests BM25 ranking.",
          mode: "offline",
          status: "active",
          detail: "Ready to evaluate",
          currentFingerprint: "ranking-fingerprint",
          selectedByDefault: false,
          changedSinceLastEvaluation: false,
          lastEvaluatedAt: "2026-08-20T10:00:00.000Z",
          lastRunId: "00000000-0000-4000-8000-000000000001",
          scenarioIds: ["bm25-term-saturation"],
        },
        {
          id: "reranking",
          label: "Reranking",
          description: "Tests result reranking.",
          mode: "online",
          status: "disabled",
          detail: "Configure a valid reranking model.",
          currentFingerprint: "reranking-fingerprint",
          selectedByDefault: false,
          changedSinceLastEvaluation: true,
          lastEvaluatedAt: null,
          lastRunId: null,
          scenarioIds: ["reranking-quality"],
        },
        {
          id: "ocr",
          label: "Document OCR",
          description: "Tests scanned document retrieval.",
          mode: "online",
          status: "disabled",
          detail: "Configure a valid document OCR model.",
          currentFingerprint: "ocr-fingerprint",
          selectedByDefault: false,
          changedSinceLastEvaluation: true,
          lastEvaluatedAt: null,
          lastRunId: null,
          scenarioIds: ["ocr-scanned-pdf"],
        },
      ],
      scenarios: [
        {
          id: "text-semantic",
          query: "What makes an Asterline canary release automatically revert?",
          expected: ["asterline-canary"],
          component: "text-embedding",
          tags: ["text", "semantic"],
          requires: ["text-embedding"],
          expectAtK: 5,
          applicable: true,
          reasons: [],
        },
        {
          id: "cross-encoder-procedure",
          query: "Which procedure validates native reranking?",
          expected: ["reranking-procedure"],
          component: "reranking",
          tags: ["reranking", "cross-encoder"],
          requires: ["cross-encoder-reranker"],
          expectAtK: 5,
          applicable: false,
          reasons: [
            "cross-encoder-reranker: disabled (configured reranker is an LLM, not a native cross-encoder)",
          ],
        },
      ],
    },
    isLoading: false,
    isError: mockCapabilitiesError,
    refetch: mockCapabilitiesRefetch,
  });
  return {
    useRetrievalEvaluationCapabilities: useCapabilities,
    useRetrievalEvaluationCapabilitiesPreview: () => {
      const result = useCapabilities();
      return {
        ...result,
        data: mockPreviewConfiguredModels
          ? {
              ...result.data,
              components: result.data.components.map((component) =>
                ["text-embedding", "reranking", "ocr"].includes(component.id)
                  ? {
                      ...component,
                      status: "active" as const,
                      detail: "Ready to evaluate",
                      selectedByDefault: true,
                      changedSinceLastEvaluation: true,
                    }
                  : component,
              ),
            }
          : result.data,
      };
    },
    useRetrievalEvaluationRuns: () => ({
      data: mockEvaluationRuns,
      isLoading: false,
      isFetching: false,
      isError: mockRunsError,
      refetch: mockRunsRefetch,
    }),
    useRetrievalEvaluationRun: (id: string | null) => ({
      data:
        (mockRunDetailOverride?.id === id ? mockRunDetailOverride : null) ??
        mockEvaluationRuns.find((run) => run.id === id) ??
        null,
      isLoading: false,
      isError: mockRunError,
      refetch: mockRunRefetch,
    }),
    useStartRetrievalEvaluation: () => ({
      mutateAsync: mockStartEvaluation,
      isPending: false,
    }),
    useCancelRetrievalEvaluation: () => ({
      mutate: mockCancelEvaluation,
      isPending: false,
    }),
    useRetrievalEvaluationComparison: () => ({
      data: mockEvaluationComparison,
      isLoading: false,
      isError: mockComparisonError,
      refetch: mockComparisonRefetch,
    }),
  };
});

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
  const page = () => (
    <QueryClientProvider client={queryClient}>
      <KnowledgeSettingsPage />
    </QueryClientProvider>
  );
  const rendered = render(page());
  return Object.assign(rendered, {
    rerenderPage: () => rendered.rerender(page()),
  });
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

function getOcrModelTrigger() {
  const modelTrigger = screen
    .getAllByRole("combobox")
    .find((el) => el.textContent?.includes("Select vision model"));

  if (!modelTrigger) {
    throw new Error("OCR model trigger not found");
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
  mockEvaluationRuns = [];
  mockRunDetailOverride = null;
  mockEvaluationComparison = null;
  mockCapabilitiesError = false;
  mockPreviewConfiguredModels = false;
  mockRunsError = false;
  mockRunError = false;
  mockComparisonError = false;
  mockStartEvaluation.mockResolvedValue({ id: "run-1" });

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
    mutateAsync: mockTestEmbeddingConnection,
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useTestEmbeddingConnection>);
  vi.mocked(useTestRerankerConnection).mockReturnValue({
    mutateAsync: mockTestRerankerConnection,
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useTestRerankerConnection>);
  vi.mocked(useTestOcrConnection).mockReturnValue({
    mutateAsync: mockTestOcrConnection,
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useTestOcrConnection>);
  mockTestEmbeddingConnection.mockResolvedValue({ success: true });
  mockTestRerankerConnection.mockResolvedValue({ success: true });
  mockTestOcrConnection.mockResolvedValue({ success: true });
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
        screen.getAllByText("Select an embedding API key first...").length,
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

    it("shows OCR model modalities and capabilities in the dropdown", async () => {
      const user = userEvent.setup();
      mockOrganization = {
        embeddingChatApiKeyId: null,
        embeddingModel: null,
        rerankerChatApiKeyId: null,
        rerankerModel: null,
        ocrChatApiKeyId: "key-1",
        ocrModel: null,
      };
      mockApiKeys = [
        {
          id: "key-1",
          name: "OCR Key",
          provider: "openai",
          scope: "org",
        },
      ];
      mockLlmModels = [
        {
          id: "vision-ocr",
          provider: "openai",
          displayName: "Vision OCR",
          capabilities: makeCapabilities({
            inputModalities: ["text", "image", "pdf"],
            supportsToolCalling: true,
          }),
        },
        {
          id: "text-only",
          provider: "openai",
          displayName: "Text Only",
          capabilities: makeCapabilities({ inputModalities: ["text"] }),
        },
        {
          id: "unknown-capabilities",
          provider: "openai",
          displayName: "Unknown Capabilities",
        },
      ];
      renderPage();

      await user.click(getOcrModelTrigger());

      expect(screen.getByText("Vision OCR")).toBeInTheDocument();
      expect(screen.getByLabelText("Supports text input")).toBeInTheDocument();
      expect(
        screen.getByLabelText("Supports vision (images)"),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Supports PDF input")).toBeInTheDocument();
      expect(
        screen.getByLabelText("128,000 token context window"),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText("Supports tool calling"),
      ).toBeInTheDocument();
      expect(screen.queryByText("Text Only")).not.toBeInTheDocument();
      expect(
        screen.queryByText("Unknown Capabilities"),
      ).not.toBeInTheDocument();
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

    it("warns immediately when an LLM reranker cannot cover cross-encoder evaluation", () => {
      mockOrganization = {
        embeddingChatApiKeyId: null,
        embeddingModel: null,
        rerankerChatApiKeyId: "openai-key",
        rerankerModel: "gpt-4o",
      };
      mockApiKeys = [
        {
          id: "openai-key",
          name: "OpenAI",
          provider: "openai",
          scope: "org",
        },
      ];
      renderPage();

      const notice = screen.getByText("openai/gpt-4o").closest('[role="note"]');
      expect(notice).not.toBeNull();
      expect(
        within(notice as HTMLElement).getByText(
          /native cross-encoder evaluation requires/i,
        ),
      ).toBeInTheDocument();
      expect(
        within(notice as HTMLElement).getByRole("link", { name: "Learn more" }),
      ).toHaveAttribute(
        "href",
        expect.stringContaining("#native-cross-encoder-and-llm-reranking"),
      );
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
      expect(screen.getAllByText("Keyword ranking").length).toBeGreaterThan(0);
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
      expect(screen.queryByText(/ready .* ago/)).not.toBeInTheDocument();
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

  describe("knowledge configuration evaluation", () => {
    const evaluationOrg = {
      embeddingChatApiKeyId: null,
      embeddingModel: null,
      rerankerChatApiKeyId: null,
      rerankerModel: null,
      ocrChatApiKeyId: null,
      ocrModel: null,
      kbBm25K1: null,
      kbBm25B: null,
    };

    beforeEach(() => {
      vi.mocked(useFeature).mockImplementation(((flag: string) => {
        if (flag === "knowledgeEvaluationBetaEnabled") return true;
        return false;
      }) as unknown as typeof useFeature);
    });

    it("is completely hidden while the beta flag is off", () => {
      vi.mocked(useFeature).mockReturnValue(
        false as unknown as ReturnType<typeof useFeature>,
      );
      mockOrganization = evaluationOrg;
      renderPage();
      expect(
        screen.queryByText("Knowledge Configuration Evaluation"),
      ).not.toBeInTheDocument();
    });

    it("keeps check selection inside the evaluation wizard", async () => {
      const user = userEvent.setup();
      mockOrganization = evaluationOrg;
      renderPage();

      expect(
        screen.getByText("Knowledge Configuration Evaluation"),
      ).toBeInTheDocument();
      expect(screen.getByText("Beta", { exact: true })).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Start evaluation" }),
      ).toBeInTheDocument();
      expect(screen.queryByText("Chunking")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("region", { name: "Evaluation checks table" }),
      ).not.toBeInTheDocument();
      expect(screen.getByText("Run an evaluation")).toBeInTheDocument();

      await user.click(
        screen.getByRole("button", { name: "Start evaluation" }),
      );
      const dialog = screen.getByRole("dialog", {
        name: "Start retrieval evaluation",
      });
      await user.click(
        within(dialog).getByTestId("retrieval-evaluation-step-checks"),
      );

      expect(within(dialog).getByText("Chunking")).toBeInTheDocument();
      expect(
        within(dialog).getByText("New and changed checks are selected"),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByText(
          /same effective configuration stay clear because a different result is not expected/i,
        ),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByRole("region", { name: "Evaluation checks table" }),
      ).toHaveAttribute("tabindex", "0");
      expect(
        within(dialog).queryByRole("columnheader", {
          name: /Status|Execution/,
        }),
      ).not.toBeInTheDocument();
      expect(
        within(dialog).getAllByText("No provider calls or model billing.")
          .length,
      ).toBeGreaterThan(0);
      expect(
        within(dialog).getByText(
          "Not selected by default because it was already tested with the current settings. No provider calls or model billing.",
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText("Test again")).not.toBeInTheDocument();
      expect(
        screen.queryByText("Tested with current settings"),
      ).not.toBeInTheDocument();
      expect(
        within(dialog).getByRole("checkbox", {
          name: "Select Image embedding",
        }),
      ).toBeDisabled();
      expect(screen.queryByText("Setup needed")).not.toBeInTheDocument();
      const imageEmbeddingRow = within(dialog)
        .getByText("Image embedding", { exact: true })
        .closest("tr");
      expect(imageEmbeddingRow).not.toBeNull();
      expect(
        within(imageEmbeddingRow as HTMLElement).getByRole("button", {
          name: "Configure embedding",
        }),
      ).toBeInTheDocument();
      const ocrCard = document.getElementById("document-ocr");
      const evaluationCard = document.getElementById(
        "retrieval-evaluation-card",
      );
      expect(ocrCard).not.toBeNull();
      expect(evaluationCard).not.toBeNull();
      if (!ocrCard || !evaluationCard) return;
      expect(
        ocrCard.compareDocumentPosition(evaluationCard) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).not.toBe(0);
    });

    it("shows actionable query errors instead of empty evaluator states", async () => {
      const user = userEvent.setup();
      mockOrganization = evaluationOrg;
      mockCapabilitiesError = true;
      mockRunsError = true;
      renderPage();

      expect(
        screen.getByText("Could not load evaluation checks"),
      ).toBeInTheDocument();
      expect(
        screen.getByText("Could not load recent evaluations"),
      ).toBeInTheDocument();
      expect(
        screen.queryByText("No evaluation checks are available."),
      ).not.toBeInTheDocument();
      const retryButtons = screen.getAllByRole("button", { name: "Retry" });
      await user.click(retryButtons[0]);
      await user.click(retryButtons[1]);
      expect(mockCapabilitiesRefetch).toHaveBeenCalled();
      expect(mockRunsRefetch).toHaveBeenCalled();
    });

    it("mirrors every evaluation-editable Knowledge setting without nested cards", async () => {
      const user = userEvent.setup();
      mockOrganization = evaluationOrg;
      renderPage();

      await user.click(
        screen.getByRole("button", { name: "Start evaluation" }),
      );
      const dialog = screen.getByRole("dialog", {
        name: "Start retrieval evaluation",
      });
      expect(
        within(dialog).getByText(
          "Confirm the Knowledge configuration for this run.",
        ),
      ).toBeInTheDocument();
      expect(
        within(dialog).queryByText(/Step \d of 3/),
      ).not.toBeInTheDocument();
      expect(
        within(dialog).getByTestId("retrieval-evaluation-step-configuration"),
      ).toHaveAttribute("aria-current", "step");
      expect(
        within(dialog).getByRole("heading", {
          name: "Embedding Configuration",
        }),
      ).toBeInTheDocument();
      expect(
        within(dialog).getAllByRole("button", {
          name: "Add LLM Provider Key",
        })[0],
      ).toHaveClass("ring-2");
      expect(
        within(dialog).getByRole("combobox", { name: "Embedding model" }),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByRole("heading", { name: "Keyword ranking" }),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByRole("combobox", { name: "Reranking model" }),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByRole("heading", {
          name: "Document OCR",
        }),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByRole("combobox", { name: "Document OCR model" }),
      ).toBeInTheDocument();
      expect(within(dialog).getByLabelText("Term Saturation")).toHaveValue(1.2);
      expect(
        within(dialog).getByRole("combobox", { name: "Context generation" }),
      ).toBeInTheDocument();
      expect(dialog.querySelector('[data-slot="card"]')).toBeNull();
      expect(dialog.querySelectorAll('[data-slot="separator"]')).toHaveLength(
        4,
      );
      expect(
        within(dialog).queryByText(
          /The model that turns your documents into searchable meaning/,
        ),
      ).not.toBeInTheDocument();
      expect(
        within(dialog).queryByText(/Orders the passages a search has found/),
      ).not.toBeInTheDocument();
      expect(
        within(dialog).queryByText(
          /Reads the text in scanned or image-only PDF pages/,
        ),
      ).not.toBeInTheDocument();
      expect(within(dialog).queryByText("Learn more.")).not.toBeInTheDocument();
      const footer = within(
        dialog.querySelector('[data-slot="dialog-footer"]') as HTMLElement,
      );
      expect(footer.getByRole("button", { name: "Cancel" })).toBeEnabled();
      expect(footer.getByRole("button", { name: "Checks" })).toBeEnabled();
      await user.click(footer.getByRole("button", { name: "Checks" }));
      expect(
        within(dialog).getByText("Choose the evaluation checks to run."),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByTestId("retrieval-evaluation-step-checks"),
      ).toHaveAttribute("aria-current", "step");
      expect(
        within(dialog).getByText("Configuration required"),
      ).toBeInTheDocument();
      expect(
        footer.getByRole("button", { name: "Start evaluation" }),
      ).toBeDisabled();
      const imageEmbeddingRow = within(dialog)
        .getByText("Image embedding", { exact: true })
        .closest("tr");
      expect(imageEmbeddingRow).not.toBeNull();
      await user.click(
        within(imageEmbeddingRow as HTMLElement).getByRole("button", {
          name: "Configure embedding",
        }),
      );
      expect(
        within(dialog).getByText(
          "Confirm the Knowledge configuration for this run.",
        ),
      ).toBeInTheDocument();
      await waitFor(() =>
        expect(
          dialog.querySelector("#evaluation-embedding-configuration"),
        ).toHaveFocus(),
      );
    });

    it("moves to Checks before validating incomplete settings against the selected checks", async () => {
      const user = userEvent.setup();
      mockApiKeys = [
        {
          id: "embedding-key",
          name: "OpenAI",
          provider: "openai",
          scope: "org",
        },
      ];
      mockOrganization = {
        ...evaluationOrg,
        embeddingChatApiKeyId: "embedding-key",
        embeddingModel: null,
      };
      renderPage();

      await user.click(
        screen.getByRole("button", { name: "Start evaluation" }),
      );
      const dialog = screen.getByRole("dialog", {
        name: "Start retrieval evaluation",
      });
      const footer = within(
        dialog.querySelector('[data-slot="dialog-footer"]') as HTMLElement,
      );

      expect(footer.getByRole("button", { name: "Checks" })).toBeEnabled();
      await user.click(footer.getByRole("button", { name: "Checks" }));

      expect(
        within(dialog).getByText("Configuration required"),
      ).toBeInTheDocument();
      expect(
        footer.getByRole("button", { name: "Start evaluation" }),
      ).toBeDisabled();

      await user.click(
        within(dialog).getByRole("checkbox", {
          name: "Select Text embedding",
        }),
      );

      expect(
        within(dialog).queryByText("Configuration required"),
      ).not.toBeInTheDocument();
      expect(
        footer.getByRole("button", { name: "Start evaluation" }),
      ).toBeEnabled();
    });

    it("submits the complete configured Knowledge settings surface", async () => {
      const user = userEvent.setup();
      mockApiKeys = [
        {
          id: "embedding-key",
          name: "Embedding",
          provider: "openai",
          scope: "org",
        },
      ];
      mockOrganization = {
        ...evaluationOrg,
        embeddingChatApiKeyId: "embedding-key",
        embeddingModel: "text-embedding-3-small",
      };
      renderPage();

      await user.click(
        screen.getByRole("button", { name: "Start evaluation" }),
      );
      const dialog = screen.getByRole("dialog", {
        name: "Start retrieval evaluation",
      });
      expect(within(dialog).getByLabelText("Term Saturation")).toHaveValue(1.2);
      await user.click(
        within(dialog).getByRole("combobox", { name: "Context generation" }),
      );
      await user.click(
        screen.getByRole("option", { name: "Per document — lower cost" }),
      );
      const footer = within(
        dialog.querySelector('[data-slot="dialog-footer"]') as HTMLElement,
      );
      await user.click(
        within(dialog).getByTestId("retrieval-evaluation-step-checks"),
      );
      await waitFor(() =>
        expect(
          within(dialog).getByTestId("retrieval-evaluation-step-checks"),
        ).toHaveAttribute("aria-current", "step"),
      );
      await user.click(
        footer.getByRole("button", { name: "Start evaluation" }),
      );

      expect(mockStartEvaluation).toHaveBeenCalledWith({
        queryLimit: 10,
        components: ["chunking", "text-embedding"],
        settingsOverrides: {
          bm25K1: 1.2,
          bm25B: 0.75,
          contextualRetrievalMode: "document",
          embedding: {
            chatApiKeyId: "embedding-key",
            model: "text-embedding-3-small",
          },
        },
      });
    });

    it("tests every configured model pair before leaving Configuration", async () => {
      const user = userEvent.setup();
      let resolveEmbedding!: (result: { success: boolean }) => void;
      let resolveReranker!: (result: { success: boolean }) => void;
      let resolveOcr!: (result: { success: boolean; error?: string }) => void;
      mockOrganization = {
        ...evaluationOrg,
        embeddingChatApiKeyId: "shared-key",
        embeddingModel: "text-embedding-3-small",
        rerankerChatApiKeyId: "shared-key",
        rerankerModel: "gpt-4o",
        ocrChatApiKeyId: "shared-key",
        ocrModel: "gpt-4o",
      };
      mockApiKeys = [
        {
          id: "shared-key",
          name: "OpenAI",
          provider: "openai",
          scope: "org",
        },
      ];
      mockTestEmbeddingConnection.mockImplementation(
        () => new Promise((resolve) => (resolveEmbedding = resolve)),
      );
      mockTestRerankerConnection.mockImplementation(
        () => new Promise((resolve) => (resolveReranker = resolve)),
      );
      mockTestOcrConnection.mockImplementation(
        () => new Promise((resolve) => (resolveOcr = resolve)),
      );
      renderPage();

      await user.click(
        screen.getByRole("button", { name: "Start evaluation" }),
      );
      const dialog = screen.getByRole("dialog", {
        name: "Start retrieval evaluation",
      });
      expect(
        within(dialog).getAllByRole("button", { name: "Test connection" }),
      ).toHaveLength(3);
      expect(
        within(dialog).getByRole("button", {
          name: "Clear embedding configuration",
        }),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByRole("button", {
          name: "Clear reranking configuration",
        }),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByRole("button", {
          name: "Clear OCR configuration",
        }),
      ).toBeInTheDocument();
      await user.click(
        within(dialog).getByTestId("retrieval-evaluation-step-checks"),
      );

      await waitFor(() => {
        expect(mockTestEmbeddingConnection).toHaveBeenCalledWith({
          embeddingChatApiKeyId: "shared-key",
          embeddingModel: "text-embedding-3-small",
        });
        expect(mockTestRerankerConnection).toHaveBeenCalledWith({
          rerankerChatApiKeyId: "shared-key",
          rerankerModel: "gpt-4o",
        });
        expect(mockTestOcrConnection).toHaveBeenCalledWith({
          ocrChatApiKeyId: "shared-key",
          ocrModel: "gpt-4o",
        });
      });
      await act(async () => {
        resolveEmbedding({ success: true });
        resolveReranker({ success: true });
        resolveOcr({
          success: false,
          error: "The selected OCR model could not read the scanned PDF.",
        });
      });
      expect(
        within(dialog).getByTestId("retrieval-evaluation-step-configuration"),
      ).toHaveAttribute("aria-current", "step");
      expect(
        await within(dialog).findAllByText(
          "The selected OCR model could not read the scanned PDF.",
        ),
      ).toHaveLength(1);
    });

    it("clears embedding only from the temporary wizard configuration", async () => {
      const user = userEvent.setup();
      mockOrganization = {
        ...evaluationOrg,
        embeddingChatApiKeyId: "embedding-key",
        embeddingModel: "text-embedding-3-small",
      };
      mockApiKeys = [
        {
          id: "embedding-key",
          name: "OpenAI",
          provider: "openai",
          scope: "org",
        },
      ];
      renderPage();

      await user.click(
        screen.getByRole("button", { name: "Start evaluation" }),
      );
      const dialog = screen.getByRole("dialog", {
        name: "Start retrieval evaluation",
      });
      await user.click(
        within(dialog).getByRole("button", {
          name: "Clear embedding configuration",
        }),
      );

      expect(
        within(dialog).getByRole("combobox", { name: "Embedding model" }),
      ).toBeDisabled();
      expect(
        within(dialog).queryByRole("button", { name: "Test connection" }),
      ).not.toBeInTheDocument();
      expect(mockUpdateKnowledgeSettings).not.toHaveBeenCalled();
    });

    it("requires cost confirmation before queuing a real evaluation", async () => {
      const user = userEvent.setup();
      mockApiKeys = [
        {
          id: "embedding-key",
          name: "Embedding",
          provider: "openai",
          scope: "org",
        },
      ];
      mockOrganization = {
        ...evaluationOrg,
        embeddingChatApiKeyId: "embedding-key",
        embeddingModel: "text-embedding-3-small",
      };
      renderPage();

      await user.click(
        screen.getByRole("button", { name: "Start evaluation" }),
      );
      const dialog = screen.getByRole("dialog", {
        name: "Start retrieval evaluation",
      });
      const footer = within(
        dialog.querySelector('[data-slot="dialog-footer"]') as HTMLElement,
      );
      await user.click(footer.getByRole("button", { name: "Checks" }));
      expect(
        within(dialog).getByText(
          "This run makes LLM API provider calls for 1 check. Provider charges may apply.",
        ),
      ).toBeInTheDocument();
      expect(within(dialog).getByText("1 test case")).toBeInTheDocument();
      await user.click(
        footer.getByRole("button", { name: "Start evaluation" }),
      );

      expect(mockStartEvaluation).toHaveBeenCalledWith({
        queryLimit: 10,
        components: ["chunking", "text-embedding"],
        settingsOverrides: {
          bm25K1: 1.2,
          bm25B: 0.75,
          contextualRetrievalMode: "disabled",
          embedding: {
            chatApiKeyId: "embedding-key",
            model: "text-embedding-3-small",
          },
        },
      });
    });

    it("runs with temporary BM25 settings without saving Knowledge settings", async () => {
      const user = userEvent.setup();
      mockOrganization = evaluationOrg;
      renderPage();

      await user.click(
        screen.getByRole("button", { name: "Start evaluation" }),
      );
      const dialog = screen.getByRole("dialog", {
        name: "Start retrieval evaluation",
      });
      expect(
        within(dialog).getByText(
          "Confirm the Knowledge configuration for this run.",
        ),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByRole("heading", {
          name: "Embedding Configuration",
        }),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByRole("heading", {
          name: "Search Ranking Configuration",
        }),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByRole("heading", { name: "Document OCR" }),
      ).toBeInTheDocument();
      expect(dialog.querySelector('[data-slot="card"]')).toBeNull();
      const k1 = within(dialog).getByLabelText("Term Saturation");
      const b = within(dialog).getByLabelText("Length Normalization");
      expect(k1).toHaveValue(1.2);
      expect(b).toHaveValue(0.75);
      await user.clear(k1);
      await user.type(k1, "0.6");
      await user.clear(b);
      await user.type(b, "0.35");
      const footer = within(
        dialog.querySelector('[data-slot="dialog-footer"]') as HTMLElement,
      );
      await user.click(footer.getByRole("button", { name: "Checks" }));
      await waitFor(() =>
        expect(
          within(dialog).getByTestId("retrieval-evaluation-step-checks"),
        ).toHaveAttribute("aria-current", "step"),
      );
      await user.click(
        within(dialog).getByRole("checkbox", {
          name: "Select Text embedding",
        }),
      );
      await user.click(
        within(dialog).getByRole("checkbox", {
          name: "Select Keyword ranking",
        }),
      );
      await user.click(footer.getByRole("button", { name: "Configuration" }));
      expect(within(dialog).getByLabelText("Term Saturation")).toHaveValue(0.6);
      expect(within(dialog).getByLabelText("Length Normalization")).toHaveValue(
        0.35,
      );
      await user.click(footer.getByRole("button", { name: "Checks" }));
      expect(
        within(dialog).getByText("Offline checks make no provider calls."),
      ).toBeInTheDocument();
      await user.click(
        footer.getByRole("button", { name: "Start evaluation" }),
      );

      expect(mockStartEvaluation).toHaveBeenCalledWith({
        queryLimit: 10,
        components: ["chunking", "keyword-ranking"],
        settingsOverrides: {
          bm25K1: 0.6,
          bm25B: 0.35,
          contextualRetrievalMode: "disabled",
        },
      });
      expect(mockUpdateKnowledgeSettings).not.toHaveBeenCalled();
    });

    it("selects checks affected by a temporary embedding model change", async () => {
      const user = userEvent.setup();
      mockApiKeys = [
        {
          id: "embedding-key",
          name: "Embedding",
          provider: "openai",
          scope: "org",
        },
      ];
      mockEmbeddingModels = [
        {
          id: "text-embedding-3-small",
          provider: "openai",
          displayName: "text-embedding-3-small",
          embeddingDimensions: 1536,
        },
        {
          id: "text-embedding-3-large",
          provider: "openai",
          displayName: "text-embedding-3-large",
          embeddingDimensions: 3072,
        },
      ];
      mockOrganization = {
        ...evaluationOrg,
        embeddingChatApiKeyId: "embedding-key",
        embeddingModel: "text-embedding-3-small",
      };
      renderPage();

      await user.click(
        screen.getByRole("button", { name: "Start evaluation" }),
      );

      const dialog = screen.getByRole("dialog", {
        name: "Start retrieval evaluation",
      });
      const footer = within(
        dialog.querySelector('[data-slot="dialog-footer"]') as HTMLElement,
      );
      await user.click(footer.getByRole("button", { name: "Checks" }));
      await user.click(
        within(dialog).getByRole("checkbox", { name: "Select Chunking" }),
      );
      await user.click(
        within(dialog).getByRole("checkbox", {
          name: "Select Text embedding",
        }),
      );
      await user.click(footer.getByRole("button", { name: "Configuration" }));
      await waitFor(() =>
        expect(
          within(dialog).getByTestId("retrieval-evaluation-step-configuration"),
        ).toHaveAttribute("aria-current", "step"),
      );
      await user.click(
        within(dialog).getByRole("combobox", { name: "Embedding model" }),
      );
      await user.click(
        screen.getByRole("button", { name: /text-embedding-3-large/ }),
      );
      await waitFor(() =>
        expect(
          mockTestEmbeddingConnection.mock.calls.length,
        ).toBeGreaterThanOrEqual(2),
      );

      await user.click(footer.getByRole("button", { name: "Checks" }));

      expect(within(dialog).getByText("1 check selected")).toBeInTheDocument();
      expect(
        within(dialog).getByRole("checkbox", { name: "Select Text embedding" }),
      ).toBeChecked();
      expect(
        within(dialog).getByRole("checkbox", { name: "Select Chunking" }),
      ).not.toBeChecked();
      expect(
        within(dialog).getByRole("checkbox", {
          name: "Select Keyword ranking",
        }),
      ).not.toBeChecked();
      expect(
        within(dialog).getByText(
          "Selected because its configuration changed for this evaluation run. Calls the configured embedding model provider; provider charges may apply.",
        ),
      ).toBeInTheDocument();

      await user.click(
        within(dialog).getByRole("checkbox", { name: "Select Text embedding" }),
      );
      await user.click(
        within(dialog).getByRole("button", { name: "Select new and changed" }),
      );
      expect(
        within(dialog).getByRole("checkbox", { name: "Select Text embedding" }),
      ).toBeChecked();
    });

    it("keeps the evaluation wizard open behind the shared add-key dialog", async () => {
      const user = userEvent.setup();
      mockOrganization = evaluationOrg;
      renderPage();

      await user.click(
        screen.getByRole("button", { name: "Start evaluation" }),
      );
      const dialog = screen.getByRole("dialog");
      const temporaryK1 = within(dialog).getByLabelText("Term Saturation");
      await user.clear(temporaryK1);
      await user.type(temporaryK1, "0.6");
      await user.click(
        within(dialog).getAllByRole("button", {
          name: "Add LLM Provider Key",
        })[0],
      );

      const addKeyDialog = screen.getByRole("dialog", {
        name: "Add LLM Provider Key",
      });
      expect(
        within(addKeyDialog).getByText(
          "Add an API key for knowledge base embeddings.",
        ),
      ).toBeInTheDocument();
      expect(dialog).toBeInTheDocument();
      expect(within(dialog).getByLabelText("Term Saturation")).toHaveValue(0.6);
      await user.click(
        within(addKeyDialog).getByRole("button", { name: "Cancel" }),
      );

      const remainingWizard = screen.getByRole("dialog", {
        name: "Start retrieval evaluation",
      });
      expect(
        within(remainingWizard).getByLabelText("Term Saturation"),
      ).toHaveValue(0.6);
    });

    it("includes every relevant configured Knowledge model pair in temporary settings", async () => {
      const user = userEvent.setup();
      mockPreviewConfiguredModels = true;
      mockApiKeys = [
        {
          id: "embedding-key",
          name: "Embedding",
          provider: "openai",
          scope: "org",
        },
        {
          id: "reranker-key",
          name: "Reranker",
          provider: "openai",
          scope: "org",
        },
        { id: "ocr-key", name: "OCR", provider: "openai", scope: "org" },
      ];
      mockLlmModels = mockLlmModels.map((model) =>
        model.id === "gpt-4o"
          ? {
              ...model,
              capabilities: makeCapabilities({
                inputModalities: ["text", "image", "pdf"],
              }),
            }
          : model,
      );
      mockOrganization = {
        ...evaluationOrg,
        embeddingChatApiKeyId: "embedding-key",
        embeddingModel: "text-embedding-3-small",
        rerankerChatApiKeyId: "reranker-key",
        rerankerModel: "gpt-4o",
        ocrChatApiKeyId: "ocr-key",
        ocrModel: "gpt-4o",
      };
      renderPage();

      await user.click(
        screen.getByRole("button", { name: "Start evaluation" }),
      );
      const dialog = screen.getByRole("dialog", {
        name: "Start retrieval evaluation",
      });
      const footer = within(
        dialog.querySelector('[data-slot="dialog-footer"]') as HTMLElement,
      );
      await user.click(footer.getByRole("button", { name: "Checks" }));
      await waitFor(() =>
        expect(
          within(dialog).getByTestId("retrieval-evaluation-step-checks"),
        ).toHaveAttribute("aria-current", "step"),
      );
      const rerankingRow = within(dialog)
        .getByText("Reranking", { exact: true })
        .closest("tr");
      const ocrRow = within(dialog)
        .getByText("Document OCR", { exact: true })
        .closest("tr");
      expect(rerankingRow).toHaveTextContent(
        "Calls the configured embedding and reranking model providers",
      );
      expect(ocrRow).toHaveTextContent(
        "Calls the configured embedding and OCR model providers",
      );
      expect(
        within(dialog).getByRole("checkbox", { name: "Select Reranking" }),
      ).toBeChecked();
      expect(
        within(dialog).getByRole("checkbox", { name: "Select Document OCR" }),
      ).toBeChecked();
      expect(
        within(dialog).getByRole("checkbox", {
          name: "Select Image embedding",
        }),
      ).toBeDisabled();
      expect(
        within(dialog).getByRole("checkbox", {
          name: "Select Image embedding",
        }),
      ).not.toBeChecked();
      await user.click(
        within(dialog).getByRole("checkbox", {
          name: "Select Keyword ranking",
        }),
      );
      await user.click(footer.getByRole("button", { name: "Configuration" }));
      await waitFor(() =>
        expect(
          within(dialog).getByTestId("retrieval-evaluation-step-configuration"),
        ).toHaveAttribute("aria-current", "step"),
      );
      expect(
        within(dialog).getByRole("heading", {
          name: "Embedding Configuration",
        }),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByRole("heading", { name: "Reranking" }),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByRole("heading", {
          name: "Document OCR",
        }),
      ).toBeInTheDocument();
      expect(dialog.querySelector('[data-slot="card"]')).toBeNull();
      expect(dialog.querySelectorAll('[data-slot="separator"]')).toHaveLength(
        4,
      );
      expect(
        within(dialog).queryByRole("button", {
          name: "Add LLM Provider Key",
        }),
      ).not.toBeInTheDocument();
      const temporaryK1 = within(dialog).getByLabelText("Term Saturation");
      await user.clear(temporaryK1);
      await user.type(temporaryK1, "0.6");
      await user.click(footer.getByRole("button", { name: "Checks" }));
      expect(
        within(dialog).getByText("Native cross-encoder will not be evaluated"),
      ).toBeInTheDocument();
      await user.click(
        footer.getByRole("button", {
          name: "Start evaluation",
        }),
      );

      expect(mockStartEvaluation).toHaveBeenCalledWith({
        queryLimit: 10,
        components: [
          "chunking",
          "text-embedding",
          "keyword-ranking",
          "reranking",
          "ocr",
        ],
        settingsOverrides: {
          embedding: {
            chatApiKeyId: "embedding-key",
            model: "text-embedding-3-small",
          },
          reranker: { chatApiKeyId: "reranker-key", model: "gpt-4o" },
          ocr: { chatApiKeyId: "ocr-key", model: "gpt-4o" },
          bm25K1: 0.6,
          bm25B: 0.75,
          contextualRetrievalMode: "disabled",
        },
      });
      expect(mockUpdateKnowledgeSettings).not.toHaveBeenCalled();
    });

    it("uses the guardrails table selection and bulk-action pattern", async () => {
      const user = userEvent.setup();
      mockOrganization = evaluationOrg;
      renderPage();
      await user.click(
        screen.getByRole("button", { name: "Start evaluation" }),
      );
      const dialog = screen.getByRole("dialog", {
        name: "Start retrieval evaluation",
      });
      const footer = within(
        dialog.querySelector('[data-slot="dialog-footer"]') as HTMLElement,
      );
      await user.click(footer.getByRole("button", { name: "Checks" }));

      const keyword = within(dialog).getByRole("checkbox", {
        name: /Keyword ranking/,
      });
      expect(keyword).not.toBeChecked();

      const selectAll = within(dialog).getByRole("checkbox", {
        name: "Select all runnable checks",
      });
      await user.click(selectAll);
      expect(
        within(dialog).getByRole("checkbox", { name: /Keyword ranking/ }),
      ).toBeChecked();
      await user.click(
        within(dialog).getByRole("checkbox", {
          name: "Select all runnable checks",
        }),
      );
      expect(
        within(dialog).getByRole("checkbox", { name: /Keyword ranking/ }),
      ).not.toBeChecked();
      expect(
        footer.getByRole("button", { name: "Start evaluation" }),
      ).toBeDisabled();
      await user.click(
        within(dialog).getByRole("button", { name: "Select new and changed" }),
      );
      expect(
        within(dialog).getByRole("checkbox", { name: /Chunking/ }),
      ).toBeChecked();
    });

    it("marks an offline-only selection as requiring no provider or billing", async () => {
      const user = userEvent.setup();
      mockOrganization = evaluationOrg;
      renderPage();
      await user.click(
        screen.getByRole("button", { name: "Start evaluation" }),
      );
      const dialog = screen.getByRole("dialog", {
        name: "Start retrieval evaluation",
      });
      const footer = within(
        dialog.querySelector('[data-slot="dialog-footer"]') as HTMLElement,
      );
      await user.click(footer.getByRole("button", { name: "Checks" }));
      await user.click(
        within(dialog).getByRole("checkbox", { name: /Text embedding/ }),
      );

      expect(
        within(dialog).getByText("Offline checks make no provider calls."),
      ).toBeInTheDocument();
    });

    it("distinguishes leaving an active evaluation from cancelling it", async () => {
      const user = userEvent.setup();
      mockOrganization = evaluationOrg;
      mockEvaluationRuns = [
        {
          id: "run-queued",
          name: "Knowledge configuration evaluation",
          status: "queued",
          stage: "queued",
          progressCurrent: 0,
          progressTotal: 0,
          progressMessage: "Waiting for an evaluation worker",
          createdAt: "2026-08-21T10:00:00.000Z",
          startedAt: null,
          completedAt: null,
          selectedComponents: ["keyword-ranking"],
        },
      ];
      renderPage();

      const viewProgress = screen.getByRole("button", {
        name: "View Knowledge configuration evaluation, Queued",
      });
      expect(
        screen.getByRole("button", { name: "Cancel evaluation" }),
      ).toBeInTheDocument();
      await user.click(viewProgress);
      let dialog = screen.getByRole("dialog");
      expect(
        within(dialog).getByRole("heading", { name: "Evaluation queued" }),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByText("This evaluation runs in the background"),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByRole("button", {
          name: "Continue in background",
        }),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByRole("button", { name: "Cancel evaluation" }),
      ).toBeInTheDocument();
      expect(within(dialog).queryByText("0%")).not.toBeInTheDocument();

      await user.click(
        within(dialog).getByRole("button", {
          name: "Continue in background",
        }),
      );
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(mockCancelEvaluation).not.toHaveBeenCalled();

      await user.click(viewProgress);
      dialog = screen.getByRole("dialog");
      await user.click(
        within(dialog).getByRole("button", { name: "Cancel evaluation" }),
      );
      expect(mockCancelEvaluation).toHaveBeenCalledWith("run-queued");
    });

    it("opens results when a background evaluation finishes on this page", async () => {
      mockOrganization = evaluationOrg;
      mockEvaluationRuns = [
        {
          id: "run-background",
          name: "Knowledge configuration evaluation",
          status: "running",
          stage: "querying",
          progressCurrent: 1,
          progressTotal: 2,
          progressMessage: "Running checks",
          createdAt: "2026-08-21T10:00:00.000Z",
          selectedComponents: ["keyword-ranking"],
        },
      ];
      const page = renderPage();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

      mockEvaluationRuns = [
        {
          ...mockEvaluationRuns[0],
          status: "failed",
          stage: "completed",
          progressCurrent: 2,
          error: "Evaluation worker stopped unexpectedly.",
        },
      ];
      mockRunDetailOverride = {
        ...mockEvaluationRuns[0],
        status: "running",
        stage: "querying",
        error: null,
      };
      page.rerenderPage();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

      mockRunDetailOverride = mockEvaluationRuns[0];
      page.rerenderPage();

      const dialog = await screen.findByRole("dialog");
      expect(
        within(dialog).getByRole("heading", { name: "Evaluation failed" }),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByText("Evaluation worker stopped unexpectedly."),
      ).toBeInTheDocument();
    });

    it("explains a completed run with issues without calling it a regression", async () => {
      const user = userEvent.setup();
      mockOrganization = evaluationOrg;
      mockEvaluationRuns = [
        {
          id: "run-with-issues",
          name: "Knowledge configuration evaluation",
          status: "degraded",
          stage: "completed",
          progressCurrent: 1,
          progressTotal: 1,
          progressMessage: "Evaluation completed with issues",
          createdAt: "2026-08-21T10:00:00.000Z",
          selectedComponents: ["ocr"],
          settingsOverrides: {},
          artifact: {
            warnings: [
              "Document OCR was skipped because its fixture was invalid.",
            ],
            queries: [],
            skippedQueries: [
              {
                id: "cross-encoder-procedure",
                component: "reranking",
                query: "Which procedure validates native reranking?",
                requires: ["cross-encoder-reranker"],
                reasons: [
                  "cross-encoder-reranker: disabled (configured reranker is an LLM, not a native cross-encoder)",
                ],
              },
            ],
            selection: {
              components: ["ocr"],
              componentResults: [
                {
                  component: "ocr",
                  mode: "online",
                  status: "skipped",
                  detail: "The OCR fixture could not be read.",
                },
              ],
            },
          },
        },
      ];
      renderPage();

      expect(screen.getByText("Completed with issues")).toBeInTheDocument();
      expect(screen.queryByText("Degraded")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "View details" }));
      const dialog = screen.getByRole("dialog");
      expect(
        within(dialog).getByText(
          "Document OCR was skipped because its fixture was invalid.",
        ),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByText("Native cross-encoder was not evaluated"),
      ).toBeInTheDocument();
      expect(within(dialog).getAllByText("Skipped (1)")).toHaveLength(2);
    });

    it("surfaces comparison as a main evaluation workflow step", () => {
      mockOrganization = evaluationOrg;
      mockEvaluationRuns = [];
      renderPage();

      expect(screen.getByText("Compare evaluations")).toBeInTheDocument();
      expect(
        screen.getByText("Complete two runs to compare settings and results."),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Compare latest" }),
      ).toBeDisabled();
    });

    it("compares component outcomes without inventing aggregate deltas for missing queries", async () => {
      const user = userEvent.setup();
      mockOrganization = evaluationOrg;
      mockEvaluationRuns = [
        {
          id: "run-new",
          name: "After",
          status: "degraded",
          stage: "completed",
          progressCurrent: 1,
          progressTotal: 1,
          progressMessage: "Finished",
          createdAt: "2026-08-21T11:00:00.000Z",
          selectedComponents: ["text-embedding"],
        },
        {
          id: "run-old",
          name: "Before",
          status: "completed",
          stage: "completed",
          progressCurrent: 1,
          progressTotal: 1,
          progressMessage: "Finished",
          createdAt: "2026-08-21T10:00:00.000Z",
          selectedComponents: ["text-embedding"],
        },
      ];
      mockEvaluationComparison = {
        a: { name: "Before", warnings: [], errors: [] },
        b: { name: "After", warnings: [], errors: [] },
        fingerprintMismatch: [],
        fingerprintNotes: [],
        configDiff: [],
        singleExpected: true,
        queries: [],
        tallies: {},
        aggregates: {},
        aggregateScope: "paired-queries",
        pairedQueryCount: 0,
        components: {
          a: ["text-embedding", "reranking"],
          b: ["text-embedding"],
          paired: ["text-embedding"],
          onlyA: ["reranking"],
          onlyB: [],
        },
        componentResults: [
          {
            component: "text-embedding",
            a: { status: "passed", detail: "passed" },
            b: { status: "failed", detail: "quality gate failed" },
            changed: true,
          },
        ],
        unpaired: { onlyA: [], onlyB: [] },
      };
      renderPage();

      await user.click(screen.getByRole("button", { name: "Compare latest" }));
      const dialog = screen.getByRole("dialog");
      expect(
        within(dialog).getByText("Regression detected"),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByText("Check outcome changes (1)"),
      ).toBeInTheDocument();
      const sharedChecksNotice = within(dialog)
        .getByText("Comparison uses shared checks")
        .closest('[role="alert"]');
      expect(sharedChecksNotice).toHaveTextContent(
        "Reranking ran only before and is omitted.",
      );
      expect(within(dialog).getByText("Passed")).toBeInTheDocument();
      expect(within(dialog).getByText("Failed")).toBeInTheDocument();
      expect(
        within(dialog).getByText("No shared test cases"),
      ).toBeInTheDocument();
    });

    it("suppresses directional results when evaluation inputs differ", async () => {
      const user = userEvent.setup();
      mockOrganization = evaluationOrg;
      mockEvaluationRuns = [
        {
          id: "run-new",
          name: "After",
          status: "degraded",
          createdAt: "2026-08-21T11:00:00.000Z",
          selectedComponents: ["text-embedding"],
        },
        {
          id: "run-old",
          name: "Before",
          status: "completed",
          createdAt: "2026-08-21T10:00:00.000Z",
          selectedComponents: ["text-embedding"],
        },
      ];
      mockEvaluationComparison = {
        a: { name: "Before", warnings: [], errors: [] },
        b: { name: "After", warnings: [], errors: [] },
        fingerprintMismatch: ["corpus"],
        fingerprintNotes: [],
        configDiff: [],
        singleExpected: true,
        queries: [],
        tallies: {},
        aggregates: {},
        aggregateScope: "paired-queries",
        pairedQueryCount: 0,
        components: {
          a: ["text-embedding"],
          b: ["text-embedding"],
          paired: ["text-embedding"],
          onlyA: [],
          onlyB: [],
        },
        componentResults: [
          {
            component: "text-embedding",
            a: { status: "passed" },
            b: { status: "failed" },
            changed: true,
          },
        ],
        unpaired: { onlyA: [], onlyB: [] },
      };
      renderPage();

      await user.click(screen.getByRole("button", { name: "Compare latest" }));
      const dialog = screen.getByRole("dialog");
      expect(
        within(dialog).getByText("Comparison limited"),
      ).toBeInTheDocument();
      expect(
        within(dialog).queryByText(/Check outcome changes/),
      ).not.toBeInTheDocument();
      expect(
        within(dialog).queryByText("No shared test cases"),
      ).not.toBeInTheDocument();
      expect(
        within(dialog).queryByRole("heading", { name: "Results" }),
      ).not.toBeInTheDocument();
    });

    it("shows one simple result table for the compared settings", async () => {
      const user = userEvent.setup();
      mockOrganization = evaluationOrg;
      mockEvaluationRuns = [
        {
          id: "run-new",
          name: "After",
          status: "completed",
          stage: "completed",
          progressCurrent: 1,
          progressTotal: 1,
          progressMessage: "Finished",
          createdAt: "2026-08-21T11:00:00.000Z",
          selectedComponents: ["keyword-ranking"],
        },
        {
          id: "run-old",
          name: "Before",
          status: "completed",
          stage: "completed",
          progressCurrent: 1,
          progressTotal: 1,
          progressMessage: "Finished",
          createdAt: "2026-08-21T10:00:00.000Z",
          selectedComponents: ["keyword-ranking"],
        },
      ];
      const side = {
        bestRank: 1,
        returned: 2,
        hit: { "1": 1, "5": 1 },
        recall: { "1": 1, "5": 1 },
        reciprocalRank: 1,
        evidence: { "1": 1, "5": 1 },
      };
      mockEvaluationComparison = {
        a: { name: "Before", warnings: [], errors: [] },
        b: { name: "After", warnings: [], errors: [] },
        fingerprintMismatch: [],
        fingerprintNotes: [],
        configDiff: [
          { key: "bm25K1", a: "1.2", b: "0.6" },
          { key: "bm25B", a: "0.75", b: "0.37" },
        ],
        singleExpected: true,
        queries: [
          {
            id: "bm25-term-saturation",
            component: "keyword-ranking",
            gateMode: "metric-only",
            query: "cedarwake Cedar queue recovery procedure",
            tags: ["bm25"],
            expected: ["cedar-primary"],
            a: { ...side, expectedScore: 1.2, scoreMargin: 0.2 },
            b: { ...side, expectedScore: 1.5, scoreMargin: 0.5 },
            direction: {
              "hit@1": "same",
              "hit@5": "same",
              mrr: "same",
              scoreMargin: "improved",
            },
            returnedChanged: false,
            changed: true,
          },
        ],
        tallies: {},
        aggregates: {
          "hit@5": { a: 1, b: 1, delta: 0 },
          mrr: { a: 1, b: 1, delta: 0 },
          meanScoreMargin: { a: 0.2, b: 0.5, delta: 0.3 },
        },
        uncertainty: {
          "hit@5": {
            estimate: 0,
            lower: 0,
            upper: 0,
            probabilityImproved: 0,
            n: 1,
          },
        },
        aggregateScope: "paired-queries",
        pairedQueryCount: 1,
        components: {
          a: ["keyword-ranking"],
          b: ["keyword-ranking"],
          paired: ["keyword-ranking"],
          onlyA: [],
          onlyB: [],
        },
        componentResults: [],
        unpaired: { onlyA: [], onlyB: [] },
      };
      renderPage();

      expect(
        screen.getByText(
          "Review changes between the two most recent completed runs.",
        ),
      ).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Compare latest" }));
      const dialog = screen.getByRole("dialog");
      expect(
        within(dialog).getByRole("heading", {
          name: "Knowledge settings comparison",
        }),
      ).toBeInTheDocument();
      expect(
        within(dialog).queryByText("No pass/fail changes"),
      ).not.toBeInTheDocument();
      expect(within(dialog).getByText("Results")).toBeInTheDocument();
      const improvements = within(dialog)
        .getByText("Improvements (1)")
        .closest("details") as HTMLDetailsElement;
      const noChangeSummary = within(dialog).getByText("No change (2)");
      const noChange = noChangeSummary.closest("details") as HTMLDetailsElement;
      expect(improvements.open).toBe(true);
      expect(noChange.open).toBe(false);
      await user.click(noChangeSummary);
      expect(noChange.open).toBe(true);
      expect(
        within(noChange).getByText("95%: 0.0 to 0.0 pp"),
      ).toBeInTheDocument();
      expect(
        within(dialog).queryByText("Test case results"),
      ).not.toBeInTheDocument();
      expect(
        within(dialog).queryByText(/Retrieval quality/),
      ).not.toBeInTheDocument();
      expect(within(dialog).queryByText(/Diagnostic/)).not.toBeInTheDocument();
      expect(
        within(dialog).getByText("Position of the first expected result"),
      ).toBeInTheDocument();
      expect(within(dialog).getByText("+150.0%")).toBeInTheDocument();
      expect(within(dialog).getByText("0.2000")).toBeInTheDocument();
      expect(within(dialog).getByText("0.5000")).toBeInTheDocument();
      expect(within(dialog).getByText("BM25 score gap")).toBeInTheDocument();
      expect(
        within(dialog).getByText("BM25 term saturation (k1)"),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByRole("heading", { name: "Changed settings (2)" }),
      ).toBeInTheDocument();
      expect(within(dialog).queryByText(/^Before:/)).not.toBeInTheDocument();
      expect(within(dialog).queryByText(/^After:/)).not.toBeInTheDocument();
      const metricDocs = [
        {
          button: "About Hit@5",
          link: /Read about Hit@5/,
          href: "https://archestra.ai/docs/platform-knowledge#hit-at-5",
        },
        {
          button: "About MRR",
          link: /Read about MRR/,
          href: "https://archestra.ai/docs/platform-knowledge#mean-reciprocal-rank-mrr",
        },
        {
          button: "About BM25 score gap",
          link: /Read about BM25 score gap/,
          href: "https://archestra.ai/docs/platform-knowledge#bm25-score-gap",
        },
      ];
      for (const metricDoc of metricDocs) {
        const trigger = within(dialog).getByRole("button", {
          name: metricDoc.button,
        });
        await user.click(trigger);
        expect(
          screen.getByRole("link", { name: metricDoc.link }),
        ).toHaveAttribute("href", metricDoc.href);
        if (metricDoc.button === "About BM25 score gap") {
          expect(
            screen.getByText(
              "Difference between the expected result's BM25 score and the highest-scoring alternative.",
            ),
          ).toBeInTheDocument();
        }
        await user.click(trigger);
      }
    });

    it("keeps BM25-only score changes out of pass/fail details", async () => {
      const user = userEvent.setup();
      mockOrganization = evaluationOrg;
      mockEvaluationRuns = [
        {
          id: "run-new",
          name: "After",
          status: "completed",
          stage: "completed",
          progressCurrent: 1,
          progressTotal: 1,
          progressMessage: "Finished",
          createdAt: "2026-08-21T11:00:00.000Z",
          selectedComponents: ["keyword-ranking"],
        },
        {
          id: "run-old",
          name: "Before",
          status: "completed",
          stage: "completed",
          progressCurrent: 1,
          progressTotal: 1,
          progressMessage: "Finished",
          createdAt: "2026-08-21T10:00:00.000Z",
          selectedComponents: ["keyword-ranking"],
        },
      ];
      const side = {
        bestRank: 1,
        returned: 2,
        hit: { "1": 1, "5": 1 },
        recall: { "1": 1, "5": 1 },
        reciprocalRank: 1,
        evidence: { "1": 1, "5": 1 },
      };
      mockEvaluationComparison = {
        a: { name: "Before", warnings: [], errors: [] },
        b: { name: "After", warnings: [], errors: [] },
        fingerprintMismatch: [],
        fingerprintNotes: [],
        configDiff: [
          { key: "bm25K1", a: "1.2", b: "0.6" },
          { key: "bm25B", a: "0.75", b: "0.35" },
        ],
        singleExpected: true,
        queries: [
          {
            id: "bm25-term-saturation",
            component: "keyword-ranking",
            gateMode: "metric-only",
            query: "cedarwake Cedar queue recovery procedure",
            tags: ["bm25"],
            expected: ["cedar-primary"],
            a: { ...side, expectedScore: 4.2, scoreMargin: 3.9052 },
            b: { ...side, expectedScore: 2.8, scoreMargin: 2.3264 },
            direction: {
              "hit@1": "same",
              "hit@5": "same",
              mrr: "same",
              scoreMargin: "regressed",
            },
            returnedChanged: false,
            changed: true,
          },
          {
            id: "bm25-length-normalization",
            component: "keyword-ranking",
            gateMode: "metric-only",
            query:
              "Which Cedar document contains the operational queue recovery procedure?",
            tags: ["bm25"],
            expected: ["cedar-primary"],
            a: { ...side, expectedScore: 2.1, scoreMargin: 1.4643 },
            b: { ...side, expectedScore: 1.1, scoreMargin: 0.5329 },
            direction: {
              "hit@1": "same",
              "hit@5": "same",
              mrr: "same",
              scoreMargin: "regressed",
            },
            returnedChanged: false,
            changed: true,
          },
        ],
        tallies: {
          "hit@5": { wins: 0, losses: 0, ties: 2 },
          mrr: { wins: 0, losses: 0, ties: 2 },
          scoreMargin: { wins: 0, losses: 2, ties: 0 },
        },
        aggregates: {
          "hit@5": { a: 1, b: 1, delta: 0 },
          mrr: { a: 1, b: 1, delta: 0 },
          meanScoreMargin: { a: 2, b: 0.745, delta: -1.255 },
        },
        aggregateScope: "paired-queries",
        pairedQueryCount: 2,
        components: {
          a: ["keyword-ranking"],
          b: ["keyword-ranking"],
          paired: ["keyword-ranking"],
          onlyA: [],
          onlyB: [],
        },
        componentResults: [],
        unpaired: { onlyA: [], onlyB: [] },
      };
      renderPage();

      await user.click(screen.getByRole("button", { name: "Compare latest" }));
      const dialog = screen.getByRole("dialog");
      expect(
        within(dialog).queryByText("No pass/fail changes"),
      ).not.toBeInTheDocument();
      expect(
        within(dialog).queryByText("Regression detected"),
      ).not.toBeInTheDocument();
      expect(
        within(dialog).queryByText("Regressions (2)"),
      ).not.toBeInTheDocument();
      expect(
        within(dialog).queryByText("Test case results"),
      ).not.toBeInTheDocument();
      const regressions = within(dialog)
        .getByText("Regressions (1)")
        .closest("details") as HTMLDetailsElement;
      const noChange = within(dialog)
        .getByText("No change (2)")
        .closest("details") as HTMLDetailsElement;
      expect(regressions.open).toBe(true);
      expect(noChange.open).toBe(false);
      expect(within(dialog).getByText("BM25 score gap")).toBeInTheDocument();
      expect(within(dialog).getAllByText("0.0%")).toHaveLength(2);
      expect(within(dialog).getByText("-62.7%")).toBeInTheDocument();
      expect(within(dialog).queryByText("-40.4%")).not.toBeInTheDocument();
      expect(within(dialog).queryByText("-63.6%")).not.toBeInTheDocument();

      const settings = within(dialog).getByRole("heading", {
        name: "Changed settings (2)",
      });
      const results = within(dialog).getByText("Results");
      expect(
        settings.compareDocumentPosition(results) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).not.toBe(0);
    });

    it("reserves the regression verdict for actual test result declines", async () => {
      const user = userEvent.setup();
      mockOrganization = evaluationOrg;
      mockEvaluationRuns = [
        {
          id: "run-new",
          name: "After",
          status: "degraded",
          stage: "completed",
          progressCurrent: 1,
          progressTotal: 1,
          progressMessage: "Finished",
          createdAt: "2026-08-21T11:00:00.000Z",
          selectedComponents: ["text-embedding"],
        },
        {
          id: "run-old",
          name: "Before",
          status: "completed",
          stage: "completed",
          progressCurrent: 1,
          progressTotal: 1,
          progressMessage: "Finished",
          createdAt: "2026-08-21T10:00:00.000Z",
          selectedComponents: ["text-embedding"],
        },
      ];
      const commonSide = {
        returned: 6,
        expectedScore: null,
        scoreMargin: null,
        recall: { "1": 1, "5": 1 },
        evidence: { "1": 1, "5": 1 },
      };
      mockEvaluationComparison = {
        a: { name: "Before", warnings: [], errors: [] },
        b: { name: "After", warnings: [], errors: [] },
        fingerprintMismatch: [],
        fingerprintNotes: [],
        configDiff: [],
        singleExpected: true,
        queries: [
          {
            id: "semantic-ranking",
            component: "text-embedding",
            query: "How does the release recover?",
            tags: ["semantic"],
            expected: ["release-guide"],
            a: {
              ...commonSide,
              bestRank: 1,
              hit: { "1": 1, "5": 1 },
              reciprocalRank: 1,
            },
            b: {
              ...commonSide,
              bestRank: 6,
              hit: { "1": 0, "5": 0 },
              reciprocalRank: 1 / 6,
            },
            direction: {
              "hit@1": "regressed",
              "hit@5": "regressed",
              mrr: "regressed",
            },
            returnedChanged: false,
            changed: true,
          },
        ],
        tallies: {
          "hit@5": { wins: 0, losses: 1, ties: 0 },
          mrr: { wins: 0, losses: 1, ties: 0 },
        },
        aggregates: {
          "hit@5": { a: 1, b: 0, delta: -1 },
          mrr: { a: 1, b: 1 / 6, delta: -(5 / 6) },
        },
        aggregateScope: "paired-queries",
        pairedQueryCount: 1,
        components: {
          a: ["text-embedding"],
          b: ["text-embedding"],
          paired: ["text-embedding"],
          onlyA: [],
          onlyB: [],
        },
        componentResults: [],
        unpaired: { onlyA: [], onlyB: [] },
      };
      renderPage();

      await user.click(screen.getByRole("button", { name: "Compare latest" }));
      const dialog = screen.getByRole("dialog");
      expect(
        within(dialog).getByText("Regression detected"),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByText(/1 of 1 paired test case regressed/),
      ).toBeInTheDocument();
      expect(
        (
          within(dialog)
            .getByText("Regressions (2)")
            .closest("details") as HTMLDetailsElement
        ).open,
      ).toBe(true);
      expect(within(dialog).getByText("Regressions (1)")).toBeInTheDocument();
      expect(within(dialog).getAllByText("-100.0%").length).toBeGreaterThan(1);
      expect(within(dialog).getAllByText("-83.3%").length).toBeGreaterThan(1);
    });

    it("does not expose a separate fixed test-case catalog", () => {
      mockOrganization = evaluationOrg;
      renderPage();

      expect(
        screen.queryByRole("button", { name: "Review 20 test cases" }),
      ).not.toBeInTheDocument();
    });

    it("lifts latest results and groups completed evaluation details", async () => {
      const user = userEvent.setup();
      mockOrganization = evaluationOrg;
      mockEvaluationRuns = [
        {
          id: "run-completed",
          name: "Knowledge configuration evaluation",
          status: "completed",
          stage: "completed",
          progressCurrent: 2,
          progressTotal: 2,
          progressMessage: "Finished",
          createdAt: "2026-08-21T10:00:00.000Z",
          completedAt: "2026-08-21T10:01:00.000Z",
          selectedComponents: ["chunking", "keyword-ranking"],
          settingsOverrides: {
            embedding: {
              chatApiKeyId: "historical-embedding-key",
              model: "text-embedding-3-small",
            },
            bm25K1: 0.6,
            bm25B: 0.35,
          },
          artifact: {
            fingerprint: {
              embedding: {
                provider: "openai",
                model: "text-embedding-3-small",
              },
            },
            aggregates: {
              "hit@5": 1,
              mrr: 1,
              "precision@5": 0.4,
              "ndcg@5": 0.9,
              "map@5": 0.8,
              "negativeHitRate@5": 0,
              noAnswerForcedRetrievalRate: 1,
            },
            bySegment: {
              category: { "hard-negative": { queries: 1 } },
              language: { en: { queries: 1 } },
              difficulty: { hard: { queries: 1 } },
            },
            uncertainty: {
              method: "deterministic-bootstrap",
              confidenceLevel: 0.95,
              samples: 2000,
              seed: "suite",
              metrics: {
                "precision@5": {
                  estimate: 0.4,
                  lower: 0.2,
                  upper: 0.6,
                  n: 1,
                },
              },
            },
            selection: {
              components: ["chunking", "keyword-ranking"],
              componentResults: [
                {
                  component: "chunking",
                  mode: "offline",
                  status: "passed",
                  detail: "Stored chunks matched the configured size.",
                },
                {
                  component: "keyword-ranking",
                  mode: "offline",
                  status: "passed",
                  detail: "Keyword ranking expectations passed.",
                },
              ],
            },
            queries: [
              {
                id: "bm25-term-saturation",
                query: "cedarwake Cedar queue recovery procedure",
                passed: true,
                stageFailures: [],
                firstRank: { "cedar-primary": 1 },
              },
              {
                id: "semantic-noisy-query",
                query: "noisy synthetic query",
                passed: true,
                gateMode: "metric-only",
                stageFailures: [],
                firstRank: { "synthetic-doc": 4 },
              },
            ],
            skippedQueries: [],
          },
        },
      ];
      renderPage();

      const latestHeading = screen.getByText("Latest evaluation");
      const runHeading = screen.getByRole("heading", {
        name: "Run an evaluation",
      });
      expect(
        latestHeading.compareDocumentPosition(runHeading) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).not.toBe(0);
      expect(screen.queryByText("Latest:")).not.toBeInTheDocument();
      expect(screen.getByText("Temporary settings")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "View details" }));
      const dialog = screen.getByRole("dialog");
      expect(
        within(dialog).getByRole("heading", { name: "Evaluation completed" }),
      ).toBeInTheDocument();
      expect(
        within(dialog).queryByText("Knowledge configuration evaluation"),
      ).not.toBeInTheDocument();
      expect(
        within(dialog).getByRole("heading", { name: "Results" }),
      ).toBeInTheDocument();
      expect(within(dialog).getByText("Precision@5")).toBeInTheDocument();
      expect(within(dialog).getByText("nDCG@5")).toBeInTheDocument();
      expect(within(dialog).getByText("MAP@5")).toBeInTheDocument();
      expect(
        within(dialog).getByText("Negative hit rate@5"),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByText("No-answer forced retrieval"),
      ).toBeInTheDocument();
      await user.click(within(dialog).getByText("Confidence and coverage"));
      expect(
        within(dialog).getByText(/Deterministic 95% bootstrap intervals/),
      ).toBeInTheDocument();
      const confidenceRow = within(dialog)
        .getAllByText("precision@5")
        .at(-1)
        ?.closest("tr");
      expect(confidenceRow).toHaveTextContent("20% – 60%");
      expect(
        within(dialog).getByRole("heading", { name: "Test settings" }),
      ).toBeInTheDocument();
      expect(within(dialog).getByText("0.6")).toBeInTheDocument();
      expect(within(dialog).getByText("0.35")).toBeInTheDocument();
      expect(
        within(dialog).getByRole("img", { name: "OpenAI" }),
      ).toBeInTheDocument();
      expect(within(dialog).getByText("OpenAI")).toBeInTheDocument();
      expect(
        within(dialog).getByRole("heading", { name: "Check results" }),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByRole("heading", { name: "Test case results" }),
      ).toBeInTheDocument();

      const passedChecks = within(dialog)
        .getByText("Passed (2)")
        .closest("details") as HTMLDetailsElement;
      const passedTests = within(dialog)
        .getByText("Passed (1)")
        .closest("details") as HTMLDetailsElement;
      const measuredOnly = within(dialog)
        .getByText("Measured only (1)")
        .closest("details") as HTMLDetailsElement;
      expect(passedChecks.open).toBe(false);
      expect(passedTests.open).toBe(false);
      expect(measuredOnly.open).toBe(false);

      await user.click(within(dialog).getByText("Passed (1)"));
      expect(passedTests.open).toBe(true);
      expect(
        within(passedTests).getByRole("columnheader", {
          name: "First expected result",
        }),
      ).toBeInTheDocument();
      expect(within(passedTests).getByText("1st result")).toBeInTheDocument();
      expect(
        within(passedTests).queryByText("First rank"),
      ).not.toBeInTheDocument();
    });

    it("shows durable run progress while polling", () => {
      mockOrganization = evaluationOrg;
      mockEvaluationRuns = [
        {
          id: "run-active",
          name: "Retrieval evaluation",
          status: "running",
          stage: "querying",
          progressCurrent: 15,
          progressTotal: 22,
          progressMessage: "Running bm25-term-saturation",
          createdAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          completedAt: null,
          selectedComponents: ["keyword-ranking"],
        },
      ];
      renderPage();

      expect(
        screen.getByText("Running bm25-term-saturation"),
      ).toBeInTheDocument();
      expect(screen.getByText("68%")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Start evaluation" }),
      ).toBeDisabled();
    });
  });
});
