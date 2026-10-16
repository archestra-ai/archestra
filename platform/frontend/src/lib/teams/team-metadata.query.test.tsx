// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { useTeams, useTeamsWithVaultFolders } from "./team.query";

const origin = "http://localhost:9000";
const server = setupServer();
const team = {
  id: "team-one",
  name: "Operations",
  description: "Shared resources",
};
beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: origin });
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
function setup(byosEnabled = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
  });
  client.setQueryData(["auth", "session"], { user: { id: "viewer" } });
  client.setQueryData(["config"], { features: { byosEnabled } });
  return {
    client,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  };
}
it("isolates compact and full caches while preserving request filters and full relations", async () => {
  const requests: URLSearchParams[] = [];
  server.use(
    http.get(`${origin}/api/teams`, ({ request }) => {
      const query = new URL(request.url).searchParams;
      requests.push(query);
      return HttpResponse.json({
        data: [
          query.get("includeRelations") === "false"
            ? team
            : {
                ...team,
                members: [{ id: "membership", userId: "viewer" }],
                labels: [],
                descendantTeams: [],
              },
        ],
      });
    }),
  );
  const { result } = renderHook(
    () => ({
      full: useTeams({ mine: true, name: " Ops ", labels: "tier:one" }),
      light: useTeams({
        mine: true,
        name: " Ops ",
        labels: "tier:one",
        includeRelations: false,
      }),
    }),
    setup(),
  );
  await waitFor(() =>
    expect(
      result.current.full.isSuccess && result.current.light.isSuccess,
    ).toBe(true),
  );
  expect(requests).toHaveLength(2);
  expect(requests.map((q) => q.get("includeRelations"))).toEqual(
    expect.arrayContaining([null, "false"]),
  );
  for (const query of requests)
    expect(Object.fromEntries(query)).toMatchObject({
      mine: "true",
      name: "Ops",
      labels: "tier:one",
      limit: "100",
      offset: "0",
    });
  expect(result.current.full.data?.[0].members).toHaveLength(1);
  expect(result.current.light.data?.[0]).toEqual(team);
});
it.each([
  false,
  true,
])("does not load team or vault data for a closed picker with BYOS=%s", async (byosEnabled) => {
  let requests = 0;
  server.use(
    http.get(`${origin}/api/teams`, () => {
      requests++;
      return HttpResponse.json({ data: [team] });
    }),
    http.get(`${origin}/api/teams/:id/vault-folder`, () => {
      requests++;
      return HttpResponse.json({ vaultPath: "shared" });
    }),
  );
  const { result, rerender } = renderHook(
    ({ enabled }) => useTeamsWithVaultFolders({ enabled }),
    { ...setup(byosEnabled), initialProps: { enabled: false } },
  );
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(requests).toBe(0);
  if (!byosEnabled) {
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(requests).toBe(0);
  }
});
it("loads compact teams and preserves vault choices when the BYOS picker opens", async () => {
  const teamQueries: URLSearchParams[] = [];
  let vaultRequests = 0;
  server.use(
    http.get(`${origin}/api/teams`, ({ request }) => {
      teamQueries.push(new URL(request.url).searchParams);
      return HttpResponse.json({ data: [team] });
    }),
    http.get(`${origin}/api/teams/:id/vault-folder`, () => {
      vaultRequests++;
      return HttpResponse.json({ vaultPath: "shared/operations" });
    }),
  );
  const { result, rerender } = renderHook(
    ({ enabled }) => useTeamsWithVaultFolders({ enabled }),
    { ...setup(true), initialProps: { enabled: false } },
  );
  expect(teamQueries).toHaveLength(0);
  rerender({ enabled: true });
  await waitFor(() =>
    expect(result.current.data).toEqual([
      { ...team, vaultPath: "shared/operations" },
    ]),
  );
  expect(teamQueries).toHaveLength(1);
  expect(teamQueries[0].get("includeRelations")).toBe("false");
  expect(vaultRequests).toBe(1);
});
