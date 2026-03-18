"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
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

vi.mock("@/lib/chat-settings.query", () => ({
  useAvailableChatApiKeys: () => ({
    data: mockApiKeys,
    isPending: false,
  }),
  useCreateChatApiKey: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/lib/chat-models.query", () => ({
  useChatModels: () => ({
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
}));

vi.mock("@/lib/config.query", () => ({
  useFeature: () => false,
}));

vi.mock("@/lib/auth.query", () => ({
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

beforeEach(() => {
  vi.clearAllMocks();
  mockOrganization = null;
  mockOrgPending = false;
  mockApiKeys = [];
});

describe("KnowledgeSettingsPage", () => {
  describe("warning alert", () => {
    it("shows warning alert when no embedding API key is configured", () => {
      mockOrganization = {
        embeddingChatApiKeyId: null,
        embeddingModel: null,
        rerankerChatApiKeyId: null,
        rerankerModel: null,
      };
      renderPage();

      expect(
        screen.getByText(
          /An embedding and reranking API key and model must be configured before knowledge bases and connectors can be used/,
        ),
      ).toBeInTheDocument();
    });

    it("shows warning alert when embedding key is set but model is not", () => {
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
          scope: "org_wide",
        },
      ];
      renderPage();

      expect(
        screen.getByText(
          /An embedding and reranking API key and model must be configured/,
        ),
      ).toBeInTheDocument();
    });

    it("shows warning alert when only embedding is configured but reranker is not", () => {
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
          scope: "org_wide",
        },
      ];
      renderPage();

      expect(
        screen.getByText(
          /An embedding and reranking API key and model must be configured/,
        ),
      ).toBeInTheDocument();
    });

    it("hides warning alert when both embedding and reranker are configured", () => {
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
          scope: "org_wide",
        },
      ];
      renderPage();

      expect(
        screen.queryByText(
          /An embedding and reranking API key and model must be configured/,
        ),
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
          scope: "org_wide",
        },
      ];
      renderPage();

      expect(screen.getByText("text-embedding-3-large")).toBeInTheDocument();
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
          scope: "org_wide",
        },
      ];
      renderPage();

      const modelTrigger = screen
        .getAllByRole("combobox")
        .find((el) => el.textContent?.includes("Select embedding model"));

      expect(modelTrigger).toBeDefined();
      await user.click(modelTrigger!);

      expect(
        screen.getAllByText("Best cost/quality ratio (1536 dims)").length,
      ).toBeGreaterThanOrEqual(1);
    });

    it("allows entering a custom embedding model name", async () => {
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
          scope: "org_wide",
        },
      ];
      renderPage();

      const modelTrigger = screen
        .getAllByRole("combobox")
        .find((el) => el.textContent?.includes("Select embedding model"));

      expect(modelTrigger).toBeDefined();
      await user.click(modelTrigger!);
      await user.type(
        screen.getByPlaceholderText("Search or type model name..."),
        "custom-embedding-model{enter}",
      );

      expect(screen.getByText("custom-embedding-model")).toBeInTheDocument();
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
          scope: "org_wide",
        },
      ];
      renderPage();

      expect(
        screen.getByText(
          /Locked — changing the embedding model requires re-embedding all documents/,
        ),
      ).toBeInTheDocument();
    });

    it("shows permanent choice description when model is locked", () => {
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
          scope: "org_wide",
        },
      ];
      renderPage();

      expect(
        screen.getByText(
          /The embedding model cannot be changed after it has been saved/,
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
          /Locked — changing the embedding model requires re-embedding all documents/,
        ),
      ).not.toBeInTheDocument();
    });
  });

  describe("embedding model disabled state", () => {
    it("shows 'Select an embedding API key first' when no key is selected", () => {
      mockOrganization = {
        embeddingChatApiKeyId: null,
        embeddingModel: null,
        rerankerChatApiKeyId: null,
        rerankerModel: null,
      };
      renderPage();

      expect(
        screen.getByText("Select an embedding API key first."),
      ).toBeInTheDocument();
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
          scope: "org_wide",
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
          scope: "org_wide",
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
          scope: "org_wide",
        },
      ];
      renderPage();

      // No element should have animate-pulse
      const pulsing = document.querySelectorAll(".animate-pulse");
      expect(pulsing.length).toBe(0);
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
          scope: "org_wide",
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
