"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@/lib/organization.query", () => ({
  useOrganization: () => ({
    data: mockOrganization,
    isPending: mockOrgPending,
  }),
  useUpdateKnowledgeSettings: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useTestEmbeddingConnection: () => ({
    mutateAsync: vi.fn(),
    mutate: vi.fn(),
    isPending: false,
  }),
  useDropEmbeddingConfig: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

let mockApiKeys: Array<{
  id: string;
  name: string;
  provider: string;
  scope: string;
}> = [];
let mockEmbeddingModels: Array<{
  id: string;
  provider: string;
  displayName: string;
  embeddingDimensions: 3072 | 1536 | 768 | null;
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
    data: [
      { id: "gpt-4o", provider: "openai", displayName: "GPT-4o" },
      {
        id: "claude-3-opus",
        provider: "anthropic",
        displayName: "Claude 3 Opus",
      },
    ],
    isPending: false,
  }),
  useEmbeddingModels: () => ({
    data: mockEmbeddingModels,
    isPending: false,
  }),
  useModelsWithApiKeys: () => ({
    data: mockEmbeddingModels.map((m) => ({
      id: m.id,
      provider: m.provider,
      embeddingDimensions: m.embeddingDimensions,
      apiKeys: mockApiKeys
        .filter((k) => k.provider === m.provider)
        .map((k) => ({ id: k.id })),
    })),
    isPending: false,
  }),
}));

vi.mock("@/lib/config/config.query", () => ({
  useFeature: () => false,
  useProviderBaseUrls: () => ({
    data: {},
  }),
}));

vi.mock("@/lib/team.query", () => ({
  useTeams: () => ({
    data: [],
    isPending: false,
  }),
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: () => ({ data: true, isPending: false }),
  useMissingPermissions: () => [],
}));

vi.mock("@/lib/clients/auth/auth-client", () => ({
  authClient: {
    useSession: vi.fn().mockReturnValue({
      data: {
        user: { id: "test-user", email: "test@example.com" },
        session: { id: "test-session" },
      },
    }),
  },
}));

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

beforeEach(() => {
  vi.clearAllMocks();
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
});

describe("KnowledgeSettingsPage", () => {
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
      ).toHaveAttribute("href", "/llm/providers/models");
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

      expect(
        screen.getByText(
          /To change the embedding model, drop the existing index/,
        ),
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

      expect(
        screen.getByText(
          /To change the embedding model, drop the existing index/,
        ),
      ).toBeInTheDocument();
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
        screen.queryByText(
          /To change the embedding model, drop the existing index/,
        ),
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

      const triggers = screen.getAllByRole("combobox");
      const embeddingKeyTrigger = triggers[0];
      expect(embeddingKeyTrigger).toBeDisabled();
    });
  });

  describe("pulsing animation setup steps", () => {
    it("pulses Add LLM Provider Key button when no OpenAI keys exist", () => {
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
      expect(addButtons[0].className).toContain("animate-pulse");
      expect(addButtons[0].className).toContain("ring-primary/40");
    });

    it("pulses key selector dropdown when OpenAI keys exist but none selected", () => {
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

      // The embedding key selector trigger should have pulse classes
      const triggers = screen.getAllByRole("combobox");
      const embeddingKeyTrigger = triggers[0];
      expect(embeddingKeyTrigger.className).toContain("animate-pulse");
      expect(embeddingKeyTrigger.className).toContain("ring-primary/40");
    });

    it("pulses model dropdown when key selected but model not selected", () => {
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
      expect(modelTrigger?.className).toContain("animate-pulse");
      expect(modelTrigger?.className).toContain("ring-primary/40");
    });

    it("does not pulse anything when embedding is fully configured", () => {
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

      // No element should have animate-pulse
      const pulsing = document.querySelectorAll(".animate-pulse");
      expect(pulsing.length).toBe(0);
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

      expect(
        screen.getByRole("option", { name: /OpenAI/i }),
      ).not.toHaveAttribute("data-disabled");
      expect(
        screen.getByRole("option", { name: /Ollama/i }),
      ).not.toHaveAttribute("data-disabled");
      expect(
        screen.getByRole("option", { name: /Anthropic/i }),
      ).not.toHaveAttribute("data-disabled");
      expect(
        screen.getByRole("option", { name: /Gemini/i }),
      ).not.toHaveAttribute("data-disabled");
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

      expect(screen.getByText("Reranking Configuration")).toBeInTheDocument();
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
});
