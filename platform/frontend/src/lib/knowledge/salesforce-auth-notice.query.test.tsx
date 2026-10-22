import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { useHasLegacySalesforceConnector } from "./connector.query";

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
function renderNoticeQuery() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const query = renderHook(() => useHasLegacySalesforceConnector(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return { ...query, client };
}
const oauth = {
  config: { type: "salesforce", authMethod: "oauth_client_credentials" },
};
it.each([
  undefined,
  "soap_legacy",
])("finds legacy method %s beyond a short filtered page, then clears after migration", async (authMethod) => {
  const offsets: number[] = [];
  let migrated = false;
  server.use(
    http.get(`${origin}/api/connectors`, ({ request }) => {
      const url = new URL(request.url);
      expect(url.searchParams.get("connectorType")).toBe("salesforce");
      expect(url.searchParams.has("search")).toBe(false);
      expect(url.searchParams.has("access")).toBe(false);
      const offset = Number(url.searchParams.get("offset"));
      offsets.push(offset);
      return HttpResponse.json({
        data:
          offset === 0
            ? Array.from({ length: 99 }, () => oauth)
            : [
                migrated
                  ? oauth
                  : { config: { type: "salesforce", authMethod } },
              ],
        pagination: { total: 101 },
      });
    }),
  );
  const { result, client } = renderNoticeQuery();
  await waitFor(() => expect(result.current.data).toBe(true));
  expect(offsets).toEqual([0, 100]);
  migrated = true;
  await act(() => client.invalidateQueries({ queryKey: ["connectors"] }));
  await waitFor(() => expect(result.current.data).toBe(false));
});
it("stops scanning as soon as it finds a password connector", async () => {
  let requests = 0;
  server.use(
    http.get(`${origin}/api/connectors`, () => {
      requests++;
      return HttpResponse.json({
        data: [{ config: { type: "salesforce" } }],
        pagination: { total: 200 },
      });
    }),
  );
  const { result } = renderNoticeQuery();
  await waitFor(() => expect(result.current.data).toBe(true));
  expect(requests).toBe(1);
});
it("does not warn when there are no accessible Salesforce connectors", async () => {
  server.use(
    http.get(`${origin}/api/connectors`, () =>
      HttpResponse.json({ data: [], pagination: { total: 0 } }),
    ),
  );
  const { result } = renderNoticeQuery();
  await waitFor(() => expect(result.current.data).toBe(false));
});
