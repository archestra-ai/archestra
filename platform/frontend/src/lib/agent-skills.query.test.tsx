import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  useAgentActivationSkillPolicy,
  useAgentActivationSkills,
} from "./agent-skills.query";
import { useCreateSkill, useDeleteSkill } from "./skills/skill.query";

const API_ORIGIN = "http://localhost:9000";
const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("useAgentActivationSkills", () => {
  it("loads a searchable page for a new agent in the Default environment", async () => {
    let requestedUrl: URL | undefined;
    server.use(
      http.get(`${API_ORIGIN}/api/agents/activation-skills`, ({ request }) => {
        requestedUrl = new URL(request.url);
        return HttpResponse.json({
          enabled: true,
          data: [],
          pagination: {
            currentPage: 2,
            limit: 10,
            total: 12,
            totalPages: 2,
            hasNext: false,
            hasPrev: true,
          },
        });
      }),
    );

    const { result } = renderHook(
      () =>
        useAgentActivationSkills({
          environmentId: undefined,
          limit: 10,
          offset: 10,
          search: "incident",
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requestedUrl?.searchParams.get("agentId")).toBeNull();
    expect(requestedUrl?.searchParams.get("environmentId")).toBeNull();
    expect(requestedUrl?.searchParams.get("limit")).toBe("10");
    expect(requestedUrl?.searchParams.get("offset")).toBe("10");
    expect(requestedUrl?.searchParams.get("search")).toBe("incident");
    expect(result.current.data).toMatchObject({ enabled: true, data: [] });
  });

  it("refreshes the eligible collection after a skill is created", async () => {
    let catalogReads = 0;
    const existingSkill = {
      reference: { source: "native", skillId: "skill-1" },
      name: "existing-skill",
      activationName: "existing-skill",
      description: "Already available",
      scope: "org",
      providerName: null,
    };
    const createdSkill = {
      ...existingSkill,
      reference: { source: "native", skillId: "skill-2" },
      name: "new-skill",
      activationName: "new-skill",
      description: "Just created",
    };
    server.use(
      http.get(`${API_ORIGIN}/api/agents/activation-skills`, () => {
        catalogReads += 1;
        const data =
          catalogReads === 1 ? [existingSkill] : [existingSkill, createdSkill];
        return HttpResponse.json({
          enabled: true,
          data,
          pagination: {
            currentPage: 1,
            limit: 100,
            total: data.length,
            totalPages: 1,
            hasNext: false,
            hasPrev: false,
          },
        });
      }),
      http.post(`${API_ORIGIN}/api/skills`, () =>
        HttpResponse.json({ id: "skill-2" }),
      ),
    );
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: 60_000 },
        mutations: { retry: false },
      },
    });
    const sharedWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const candidates = renderHook(
      () =>
        useAgentActivationSkills({
          agentId: "agent-1",
          limit: 100,
          offset: 0,
          view: "eligible",
        }),
      { wrapper: sharedWrapper },
    );
    const create = renderHook(() => useCreateSkill(), {
      wrapper: sharedWrapper,
    });

    await waitFor(() =>
      expect(candidates.result.current.data?.data).toHaveLength(1),
    );
    candidates.unmount();
    await act(() =>
      create.result.current.mutateAsync({
        content: "---\nname: new-skill\ndescription: Just created\n---\n",
        files: [],
        scope: "org",
        teamIds: [],
        userIds: [],
        environmentIds: [],
        labels: [],
      }),
    );

    const refreshedCandidates = renderHook(
      () =>
        useAgentActivationSkills({
          agentId: "agent-1",
          limit: 100,
          offset: 0,
          view: "eligible",
        }),
      { wrapper: sharedWrapper },
    );
    await waitFor(() =>
      expect(refreshedCandidates.result.current.data?.data).toHaveLength(2),
    );
    expect(catalogReads).toBe(2);
  });

  it("refreshes an agent policy after a bound skill is deleted", async () => {
    let policyReads = 0;
    server.use(
      http.get(
        `${API_ORIGIN}/api/agents/agent-1/activation-skill-policy`,
        () => {
          policyReads += 1;
          return HttpResponse.json({
            mode: "manual",
            revision: policyReads === 1 ? 0 : 1,
            allowedReferences: [],
            excludedReferences: [],
            hiddenAllowedCount: policyReads === 1 ? 1 : 0,
            hiddenExcludedCount: 0,
            allowedSkills: [],
            excludedSkills: [],
          });
        },
      ),
      http.delete(`${API_ORIGIN}/api/skills/skill-1`, () =>
        HttpResponse.json({ success: true }),
      ),
    );
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: 60_000 },
        mutations: { retry: false },
      },
    });
    const sharedWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const policy = renderHook(() => useAgentActivationSkillPolicy("agent-1"), {
      wrapper: sharedWrapper,
    });
    const remove = renderHook(() => useDeleteSkill(), {
      wrapper: sharedWrapper,
    });

    await waitFor(() =>
      expect(policy.result.current.data?.hiddenAllowedCount).toBe(1),
    );
    await act(() => remove.result.current.mutateAsync("skill-1"));
    await waitFor(() =>
      expect(policy.result.current.data?.hiddenAllowedCount).toBe(0),
    );
    expect(policyReads).toBe(2);
  });
});
