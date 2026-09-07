import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, expect, it } from "vitest";
import { PermissionsCard } from "./permissions-card";

const server = setupServer(
  http.get("http://localhost:9000/api/user/permissions", () =>
    HttpResponse.json({ log: ["read"] }),
  ),
  http.get("http://localhost:9000/api/user/permission-sources", () =>
    HttpResponse.json([
      { role: "log_reader", team: null, permissions: { log: ["read"] } },
      {
        role: "operations",
        team: { id: "team-1", name: "Support" },
        permissions: { log: ["read"] },
      },
    ]),
  ),
);
beforeAll(() => {
  archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
  server.listen({ onUnhandledRequest: "error" });
});
afterAll(() => server.close());
it("shows every direct and team source for a permission", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(["auth", "session"], {
    user: { id: "user-1" },
    session: { id: "session-1" },
  });
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={client}>
      <PermissionsCard />
    </QueryClientProvider>,
  );
  await user.click(await screen.findByRole("button", { name: "Expand all" }));
  expect(
    await screen.findByText("Log Reader · Direct assignment"),
  ).toBeVisible();
  expect(await screen.findByText("Operations · Team: Support")).toBeVisible();
  client.clear();
});
