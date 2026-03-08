"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
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
    data: [],
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
          /An embedding API key and model must be configured before knowledge bases and connectors can be used/,
        ),
      ).toBeInTheDocument();
    });

    it("hides warning alert when embedding API key is configured", () => {
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
        screen.queryByText(/An embedding API key and model must be configured/),
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

      // There are two "Add LLM Provider Key" buttons (embedding + reranker)
      // The first one (embedding) should have pulse classes
      const addButtons = screen.getAllByRole("button", {
        name: /Add LLM Provider Key/,
      });
      expect(addButtons.length).toBeGreaterThanOrEqual(1);
      const embeddingAddButton = addButtons[0];
      expect(embeddingAddButton.className).toContain("animate-pulse");
      expect(embeddingAddButton.className).toContain("ring-primary/40");
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
      // Find by the "Select embedding model..." text within a trigger
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

      // No element should have animate-pulse
      const pulsing = document.querySelectorAll(".animate-pulse");
      expect(pulsing.length).toBe(0);
    });
  });

  describe("reranking section", () => {
    it("shows (optional) label in reranking section title", () => {
      mockOrganization = {
        embeddingChatApiKeyId: null,
        embeddingModel: null,
        rerankerChatApiKeyId: null,
        rerankerModel: null,
      };
      renderPage();

      expect(screen.getByText("(optional)")).toBeInTheDocument();
    });

    it("shows 'Select a reranker API key first...' when no reranker key selected", () => {
      mockOrganization = {
        embeddingChatApiKeyId: null,
        embeddingModel: null,
        rerankerChatApiKeyId: null,
        rerankerModel: null,
      };
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
