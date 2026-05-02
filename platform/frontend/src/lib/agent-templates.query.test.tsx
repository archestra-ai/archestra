import { archestraApiSdk } from "@shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  agentTemplateKeys,
  useAgentTemplateRequirements,
} from "./agent-templates.query";

vi.mock("./utils", () => ({
  handleApiError: vi.fn(),
}));

describe("useAgentTemplateRequirements", () => {
  it("keeps requirements queries immediately stale for live provisioning state", async () => {
    const getAgentTemplateRequirementsMock = vi
      .spyOn(archestraApiSdk, "getAgentTemplateRequirements")
      .mockResolvedValue({
        data: {
          templateId: "code-reviewer",
          agentConfig: {
            name: "Code Reviewer",
            description: "Reviews repositories.",
            systemPrompt: "Review code carefully.",
            llmModel: null,
            labels: [],
            agentType: "agent",
            scope: "personal",
            teams: [],
          },
          toolAssignments: [],
          missingCatalogs: [],
          unavailableTools: [],
        },
        error: undefined,
      } as unknown as Awaited<
        ReturnType<typeof archestraApiSdk.getAgentTemplateRequirements>
      >);

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(
      () => useAgentTemplateRequirements("code-reviewer"),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.data?.templateId).toBe("code-reviewer");
    });

    const query = queryClient.getQueryCache().find({
      queryKey: agentTemplateKeys.requirements("code-reviewer"),
    });

    expect(getAgentTemplateRequirementsMock).toHaveBeenCalledWith({
      path: { id: "code-reviewer" },
    });
    const options = query?.options as unknown as {
      staleTime: number;
      refetchOnMount: string;
    };
    expect(options.staleTime).toBe(0);
    expect(options.refetchOnMount).toBe("always");

    getAgentTemplateRequirementsMock.mockRestore();
  });
});
