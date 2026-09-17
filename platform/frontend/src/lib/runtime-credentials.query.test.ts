import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { createElement, type ReactNode } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  type RuntimeCredentialUsage,
  useRuntimeCredentialUsage,
} from "@/lib/runtime-credentials.query";

const API_ORIGIN = "http://localhost:9000";
const server = setupServer();

beforeAll(() => {
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("useRuntimeCredentialUsage", () => {
  it.each([
    "reopen",
    "remount",
  ])("refreshes cached usage after removing a referencing resource (%s)", async (mode) => {
    let usage: RuntimeCredentialUsage = {
      agents: [],
      resources: [{ id: "skill-1", name: "Example skill", kind: "skill" }],
    };
    let requests = 0;
    server.use(
      http.get(`${API_ORIGIN}/api/credentials/github/usage`, () => {
        requests++;
        return HttpResponse.json(usage);
      }),
    );
    // Returning to the page must refresh even within the app's 60s cache window.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: 60_000, retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const hook = ({ credentialKey }: { credentialKey: string | null }) =>
      useRuntimeCredentialUsage(credentialKey, credentialKey !== null);
    const first = renderHook(hook, {
      wrapper,
      initialProps: { credentialKey: "github" as string | null },
    });
    await waitFor(() => expect(first.result.current.data).toEqual(usage));
    expect(requests).toBe(1);

    if (mode === "reopen") first.rerender({ credentialKey: null });
    else first.unmount();
    usage = { agents: [], resources: [] };

    let reopened = first;
    if (mode === "reopen") {
      first.rerender({ credentialKey: "github" });
    } else {
      reopened = renderHook(hook, {
        wrapper,
        initialProps: { credentialKey: "github" as string | null },
      });
    }
    await waitFor(() => expect(reopened.result.current.data).toEqual(usage));
    expect(requests).toBe(2);
    reopened.unmount();
    queryClient.clear();
  });
});
