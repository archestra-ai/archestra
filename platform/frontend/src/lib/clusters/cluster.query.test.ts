import { archestraApiSdk } from "@shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleApiError } from "@/lib/utils";
import {
  type Cluster,
  useCluster,
  useClusters,
  useCreateCluster,
  useDeleteCluster,
  useTestCluster,
  useUpdateCluster,
} from "./cluster.query";

const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();

vi.mock("@shared", async () => {
  const actual = await vi.importActual("@shared");
  return {
    ...actual,
    archestraApiSdk: {
      getClusters: vi.fn(),
      getCluster: vi.fn(),
      createCluster: vi.fn(),
      updateCluster: vi.fn(),
      deleteCluster: vi.fn(),
      testCluster: vi.fn(),
    },
  };
});

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

vi.mock("@/lib/utils", async () => {
  const actual = await vi.importActual("@/lib/utils");
  return {
    ...actual,
    handleApiError: vi.fn(),
  };
});

const sampleCluster: Cluster = {
  id: "cluster-1",
  name: "production",
  namespace: "default",
  kubeconfigSecretId: null,
  loadFromCluster: true,
  isDefault: true,
  isPersonalDefault: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const secondCluster: Cluster = {
  ...sampleCluster,
  id: "cluster-2",
  name: "staging",
  isDefault: false,
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  const Wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return { Wrapper, queryClient };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useClusters", () => {
  it("returns the cluster list from the SDK", async () => {
    vi.mocked(archestraApiSdk.getClusters).mockResolvedValue({
      data: [sampleCluster, secondCluster],
    } as Awaited<ReturnType<typeof archestraApiSdk.getClusters>>);

    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useClusters(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual([sampleCluster, secondCluster]);
    expect(archestraApiSdk.getClusters).toHaveBeenCalledTimes(1);
  });

  it("returns an empty array when the SDK reports an error", async () => {
    const error = { error: { message: "boom", type: "api_error" } };
    vi.mocked(archestraApiSdk.getClusters).mockResolvedValue({
      error,
    } as Awaited<ReturnType<typeof archestraApiSdk.getClusters>>);

    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useClusters(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual([]);
    expect(handleApiError).toHaveBeenCalledWith(error);
  });
});

describe("useCluster", () => {
  it("fetches a single cluster by id", async () => {
    vi.mocked(archestraApiSdk.getCluster).mockResolvedValue({
      data: sampleCluster,
    } as Awaited<ReturnType<typeof archestraApiSdk.getCluster>>);

    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useCluster("cluster-1"), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(sampleCluster);
    expect(archestraApiSdk.getCluster).toHaveBeenCalledWith({
      path: { id: "cluster-1" },
    });
  });

  it("does not fire when id is missing", () => {
    const { Wrapper } = createWrapper();
    renderHook(() => useCluster(undefined), { wrapper: Wrapper });

    expect(archestraApiSdk.getCluster).not.toHaveBeenCalled();
  });
});

describe("useCreateCluster", () => {
  it("calls createCluster, invalidates the list query, and shows a success toast", async () => {
    vi.mocked(archestraApiSdk.createCluster).mockResolvedValue({
      data: sampleCluster,
    } as Awaited<ReturnType<typeof archestraApiSdk.createCluster>>);

    const { Wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useCreateCluster(), {
      wrapper: Wrapper,
    });

    const body = {
      name: "production",
      namespace: "default",
      kubeconfigYaml: "apiVersion: v1\nkind: Config\n",
      loadFromCluster: false,
      isPersonalDefault: false,
    };

    await result.current.mutateAsync(body);

    expect(archestraApiSdk.createCluster).toHaveBeenCalledWith({ body });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["clusters"] });
    expect(mockToastSuccess).toHaveBeenCalled();
    expect(handleApiError).not.toHaveBeenCalled();
  });

  it("forwards SDK errors via handleApiError and rejects the mutation", async () => {
    const error = { error: { message: "bad", type: "api_validation_error" } };
    vi.mocked(archestraApiSdk.createCluster).mockResolvedValue({
      error,
    } as Awaited<ReturnType<typeof archestraApiSdk.createCluster>>);

    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useCreateCluster(), {
      wrapper: Wrapper,
    });

    await expect(
      result.current.mutateAsync({ name: "x" }),
    ).rejects.toBeDefined();

    expect(handleApiError).toHaveBeenCalledWith(error);
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });
});

describe("useUpdateCluster", () => {
  it("calls updateCluster with id+body, invalidates list, and shows a success toast", async () => {
    vi.mocked(archestraApiSdk.updateCluster).mockResolvedValue({
      data: { ...sampleCluster, name: "renamed" },
    } as Awaited<ReturnType<typeof archestraApiSdk.updateCluster>>);

    const { Wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useUpdateCluster(), {
      wrapper: Wrapper,
    });

    await result.current.mutateAsync({
      id: "cluster-1",
      body: { name: "renamed" },
    });

    expect(archestraApiSdk.updateCluster).toHaveBeenCalledWith({
      path: { id: "cluster-1" },
      body: { name: "renamed" },
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["clusters"] });
    expect(mockToastSuccess).toHaveBeenCalled();
  });
});

describe("useDeleteCluster", () => {
  it("calls deleteCluster, invalidates list, and shows a success toast", async () => {
    vi.mocked(archestraApiSdk.deleteCluster).mockResolvedValue({
      data: null,
    } as unknown as Awaited<ReturnType<typeof archestraApiSdk.deleteCluster>>);

    const { Wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useDeleteCluster(), {
      wrapper: Wrapper,
    });

    await result.current.mutateAsync("cluster-2");

    expect(archestraApiSdk.deleteCluster).toHaveBeenCalledWith({
      path: { id: "cluster-2" },
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["clusters"] });
    expect(mockToastSuccess).toHaveBeenCalled();
  });
});

describe("useTestCluster", () => {
  it("calls testCluster and returns its payload on success", async () => {
    vi.mocked(archestraApiSdk.testCluster).mockResolvedValue({
      data: { ok: true, namespacesVisible: 5 },
    } as Awaited<ReturnType<typeof archestraApiSdk.testCluster>>);

    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useTestCluster(), { wrapper: Wrapper });

    const payload = await result.current.mutateAsync("cluster-1");

    expect(archestraApiSdk.testCluster).toHaveBeenCalledWith({
      path: { id: "cluster-1" },
    });
    expect(payload).toEqual({ ok: true, namespacesVisible: 5 });
    expect(mockToastSuccess).toHaveBeenCalled();
  });

  it("shows an error toast when the connection check fails", async () => {
    vi.mocked(archestraApiSdk.testCluster).mockResolvedValue({
      data: { ok: false, error: "unreachable" },
    } as Awaited<ReturnType<typeof archestraApiSdk.testCluster>>);

    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useTestCluster(), { wrapper: Wrapper });

    const payload = await result.current.mutateAsync("cluster-1");

    expect(payload).toEqual({ ok: false, error: "unreachable" });
    expect(mockToastError).toHaveBeenCalled();
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });
});
