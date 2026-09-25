// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { useKnowledgePermissionSelection } from "./knowledge/knowledge-file.query";
import { useAddBulkResourceAccess } from "./resource-permissions.query";

vi.mock("sonner");
const origin = "http://localhost:9000";
const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: origin });
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

it("bulk additions preserve owners and stronger existing permissions, and report revision conflicts per resource", async () => {
  const owner = {
    subject: { type: "user", id: "owner" },
    actions: ["read", "use", "update", "delete", "manage-permissions"],
  };
  const writes: { scope: string; body: unknown }[] = [];
  server.use(
    http.get(
      `${origin}/api/resource-permissions/knowledgeFile/:scope`,
      ({ params }) =>
        HttpResponse.json({
          resource: "knowledgeFile",
          scope: params.scope,
          revision: 7,
          grants: [
            owner,
            {
              subject: { type: "team", id: "support" },
              actions: ["read", "use", "update"],
            },
          ],
        }),
    ),
    http.put(
      `${origin}/api/resource-permissions/knowledgeFile/:scope`,
      async ({ params, request }) => {
        writes.push({
          scope: String(params.scope),
          body: await request.json(),
        });
        return params.scope === "conflict"
          ? HttpResponse.json(
              {
                error: {
                  message: "Permissions changed. Reload before saving.",
                  type: "conflict",
                },
              },
              { status: 409 },
            )
          : HttpResponse.json({ revision: 8 });
      },
    ),
  );
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const { result } = renderHook(
    () => useAddBulkResourceAccess("knowledgeFile"),
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  await act(async () => {
    const outcome = await result.current.mutateAsync({
      items: [
        { id: "saved", name: "Saved document" },
        { id: "conflict", name: "Changed document" },
      ],
      grants: [
        { subject: { type: "team", id: "support" }, actions: ["read"] },
        { subject: { type: "user", id: "new-reader" }, actions: ["read"] },
      ],
    });
    expect(outcome.succeeded).toEqual(["Saved document"]);
    expect(outcome.failed).toEqual([
      {
        label: "Changed document",
        error: "Permissions changed. Reload before saving.",
      },
    ]);
  });
  expect(writes).toHaveLength(2);
  for (const request of writes)
    expect(request.body).toEqual({
      revision: 7,
      grants: [
        owner,
        {
          subject: { type: "team", id: "support" },
          actions: ["read", "use", "update"],
        },
        { subject: { type: "user", id: "new-reader" }, actions: ["read"] },
      ],
    });
});

it("expands selected directories across pages and deduplicates directly selected documents", async () => {
  const offsets: string[] = [];
  server.use(
    http.get(`${origin}/api/knowledge-files`, ({ request }) => {
      const url = new URL(request.url);
      expect(url.searchParams.get("directoryId")).toBe("selected-directory");
      offsets.push(url.searchParams.get("offset") ?? "");
      const start = Number(url.searchParams.get("offset"));
      return HttpResponse.json({
        data: Array.from({ length: start === 0 ? 100 : 2 }, (_, i) => ({
          id: `file-${start + i}`,
          filename: `Document ${start + i}`,
        })),
      });
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const { result } = renderHook(
    () =>
      useKnowledgePermissionSelection(
        [
          { kind: "directory", id: "selected-directory", name: "Directory" },
          { kind: "file", id: "file-0", name: "Document 0" },
        ],
        true,
      ),
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data).toHaveLength(102);
  expect(offsets).toEqual(["0", "100"]);
});
