import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockOrganization: Record<string, unknown> | null = null;

vi.mock("@/lib/organization.query", () => ({
  useOrganization: () => ({
    data: mockOrganization,
    isPending: false,
  }),
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

import {
  useIsKnowledgeBaseConfigured,
  useKnowledgeBaseConfigStatus,
} from "./knowledge-base.query";

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  mockOrganization = null;
});

describe("useIsKnowledgeBaseConfigured", () => {
  it("returns false when organization is null", () => {
    mockOrganization = null;
    const { result } = renderHook(() => useIsKnowledgeBaseConfigured(), {
      wrapper: createWrapper(),
    });
    expect(result.current).toBe(false);
  });

  it("returns false when embedding API key is missing", () => {
    mockOrganization = {
      embeddingChatApiKeyId: null,
      embeddingModel: "text-embedding-3-small",
      rerankerChatApiKeyId: "key-2",
      rerankerModel: "gpt-4o",
    };
    const { result } = renderHook(() => useIsKnowledgeBaseConfigured(), {
      wrapper: createWrapper(),
    });
    expect(result.current).toBe(false);
  });

  it("returns false when reranker API key is missing", () => {
    mockOrganization = {
      embeddingChatApiKeyId: "key-1",
      embeddingModel: "text-embedding-3-small",
      rerankerChatApiKeyId: null,
      rerankerModel: null,
    };
    const { result } = renderHook(() => useIsKnowledgeBaseConfigured(), {
      wrapper: createWrapper(),
    });
    expect(result.current).toBe(false);
  });

  it("returns false when both embedding and reranker are missing", () => {
    mockOrganization = {
      embeddingChatApiKeyId: null,
      embeddingModel: null,
      rerankerChatApiKeyId: null,
      rerankerModel: null,
    };
    const { result } = renderHook(() => useIsKnowledgeBaseConfigured(), {
      wrapper: createWrapper(),
    });
    expect(result.current).toBe(false);
  });

  it("returns true when both embedding and reranker are fully configured", () => {
    mockOrganization = {
      embeddingChatApiKeyId: "key-1",
      embeddingModel: "text-embedding-3-small",
      rerankerChatApiKeyId: "key-2",
      rerankerModel: "gpt-4o",
    };
    const { result } = renderHook(() => useIsKnowledgeBaseConfigured(), {
      wrapper: createWrapper(),
    });
    expect(result.current).toBe(true);
  });
});

describe("useKnowledgeBaseConfigStatus", () => {
  it("returns both false when organization is null", () => {
    mockOrganization = null;
    const { result } = renderHook(() => useKnowledgeBaseConfigStatus(), {
      wrapper: createWrapper(),
    });
    expect(result.current).toEqual({ embedding: false, reranker: false });
  });

  it("returns embedding true, reranker false when only embedding configured", () => {
    mockOrganization = {
      embeddingChatApiKeyId: "key-1",
      embeddingModel: "text-embedding-3-small",
      rerankerChatApiKeyId: null,
      rerankerModel: null,
    };
    const { result } = renderHook(() => useKnowledgeBaseConfigStatus(), {
      wrapper: createWrapper(),
    });
    expect(result.current).toEqual({ embedding: true, reranker: false });
  });

  it("returns embedding false, reranker true when only reranker configured", () => {
    mockOrganization = {
      embeddingChatApiKeyId: null,
      embeddingModel: null,
      rerankerChatApiKeyId: "key-2",
      rerankerModel: "gpt-4o",
    };
    const { result } = renderHook(() => useKnowledgeBaseConfigStatus(), {
      wrapper: createWrapper(),
    });
    expect(result.current).toEqual({ embedding: false, reranker: true });
  });

  it("returns both true when fully configured", () => {
    mockOrganization = {
      embeddingChatApiKeyId: "key-1",
      embeddingModel: "text-embedding-3-small",
      rerankerChatApiKeyId: "key-2",
      rerankerModel: "gpt-4o",
    };
    const { result } = renderHook(() => useKnowledgeBaseConfigStatus(), {
      wrapper: createWrapper(),
    });
    expect(result.current).toEqual({ embedding: true, reranker: true });
  });

  it("requires both key and model for embedding to be true", () => {
    mockOrganization = {
      embeddingChatApiKeyId: "key-1",
      embeddingModel: null,
      rerankerChatApiKeyId: "key-2",
      rerankerModel: "gpt-4o",
    };
    const { result } = renderHook(() => useKnowledgeBaseConfigStatus(), {
      wrapper: createWrapper(),
    });
    expect(result.current.embedding).toBe(false);
  });

  it("requires both key and model for reranker to be true", () => {
    mockOrganization = {
      embeddingChatApiKeyId: "key-1",
      embeddingModel: "text-embedding-3-small",
      rerankerChatApiKeyId: "key-2",
      rerankerModel: null,
    };
    const { result } = renderHook(() => useKnowledgeBaseConfigStatus(), {
      wrapper: createWrapper(),
    });
    expect(result.current.reranker).toBe(false);
  });
});
