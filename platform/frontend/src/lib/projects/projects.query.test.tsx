import { archestraApiSdk } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleApiError } from "@/lib/utils";
import { useRestoreProject } from "./projects.query";

// The module destructures the SDK at import time, so every name it takes has
// to exist on the mock even though only `restoreProject` is exercised here.
vi.mock("@archestra/shared", async () => {
  const actual =
    await vi.importActual<typeof import("@archestra/shared")>(
      "@archestra/shared",
    );
  return {
    ...actual,
    archestraApiSdk: {
      createProject: vi.fn(),
      createProjectFromConversation: vi.fn(),
      deleteProject: vi.fn(),
      deleteSkillSandboxArtifact: vi.fn(),
      getProject: vi.fn(),
      getProjectConversations: vi.fn(),
      getProjectFiles: vi.fn(),
      getProjectInstructions: vi.fn(),
      getProjects: vi.fn(),
      permanentlyDeleteProject: vi.fn(),
      pinProject: vi.fn(),
      restoreProject: vi.fn(),
      setProjectInstructions: vi.fn(),
      setProjectShare: vi.fn(),
      unpinProject: vi.fn(),
      updateProject: vi.fn(),
      uploadProjectFiles: vi.fn(),
    },
  };
});

vi.mock("@/lib/utils", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/utils")>("@/lib/utils");
  return { ...actual, handleApiError: vi.fn() };
});

vi.mock("sonner");

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

const mockedRestore = vi.mocked(archestraApiSdk.restoreProject);

describe("useRestoreProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("answers a name collision with a remedy the UI actually offers", async () => {
    mockedRestore.mockResolvedValue({
      data: undefined,
      error: {
        message:
          'cannot restore: its owner already has an active project named "Notes". ' +
          "Restore it under a different name by passing `name`.",
        type: "api_conflict_error",
      },
    } as unknown as Awaited<ReturnType<typeof archestraApiSdk.restoreProject>>);

    const { result } = renderHook(() => useRestoreProject(), {
      wrapper: createWrapper(),
    });
    result.current.mutate({ id: "project-1" });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
    // The API's own copy tells the caller to pass `name`, which no UI can do.
    const [message] = vi.mocked(toast.error).mock.calls[0];
    expect(message).not.toContain("passing");
    expect(message).toContain("Rename that project");
    // Its own toast replaces the generic one rather than stacking with it.
    expect(handleApiError).not.toHaveBeenCalled();
  });

  it("leaves every other failure to the shared error handler", async () => {
    mockedRestore.mockResolvedValue({
      data: undefined,
      error: { message: "Project not found", type: "api_not_found_error" },
    } as unknown as Awaited<ReturnType<typeof archestraApiSdk.restoreProject>>);

    const { result } = renderHook(() => useRestoreProject(), {
      wrapper: createWrapper(),
    });
    result.current.mutate({ id: "project-1" });

    await waitFor(() => {
      expect(handleApiError).toHaveBeenCalled();
    });
    expect(toast.error).not.toHaveBeenCalled();
  });
});
