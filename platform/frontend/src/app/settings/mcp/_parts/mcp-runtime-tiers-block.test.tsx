import {
  archestraApiClient,
  type McpRuntimeTierSettingsInput,
  resolveMcpRuntimeTiers,
} from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { organizationKeys } from "@/lib/organization.query";
import { McpRuntimeTiersBlock } from "./mcp-runtime-tiers-block";

const origin = "http://localhost:9000";
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => archestraApiClient.setConfig({ baseUrl: origin }));
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

it("saves independent MCP tiers with the same CPU-derived GiB defaults and preserves agent settings", async () => {
  let tiers: McpRuntimeTierSettingsInput["tiers"] = [
    {
      name: "MCP small",
      cpuRequest: 0.1,
      cpuLimit: null as number | null,
      memoryRequestMiB: 128,
      memoryLimitMiB: 512,
    },
  ];
  let body: unknown;
  server.use(
    http.get(`${origin}/api/organization/mcp-runtime-tiers`, () =>
      HttpResponse.json(resolveMcpRuntimeTiers({ tiers })),
    ),
    http.patch(
      `${origin}/api/organization/mcp-runtime-tiers`,
      async ({ request }) => {
        body = await request.json();
        tiers = (body as { tiers: typeof tiers }).tiers;
        return HttpResponse.json(resolveMcpRuntimeTiers({ tiers }));
      },
    ),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const agentTiers = {
    tiers: [{ name: "Agent only", cpuRequest: 4 }],
    defaultTier: "Agent only",
  };
  client.setQueryData(organizationKeys.agentRuntimeTiers(), agentTiers);
  render(
    <QueryClientProvider client={client}>
      <McpRuntimeTiersBlock canEdit />
    </QueryClientProvider>,
  );
  await screen.findByText("MCP small");
  await userEvent.click(screen.getByRole("button", { name: "Create tier" }));
  const dialog = screen.getByRole("dialog", { name: "Create tier" });
  expect(within(dialog).queryByLabelText("Disk (GiB)")).not.toBeInTheDocument();
  expect(within(dialog).queryByLabelText("Pooled")).not.toBeInTheDocument();
  expect(
    within(dialog).queryByLabelText("Default tier"),
  ).not.toBeInTheDocument();
  await userEvent.type(within(dialog).getByLabelText("Name"), "MCP medium");
  await userEvent.type(within(dialog).getByLabelText("CPU request"), "0.5");
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Create tier" }),
  );
  await waitFor(() =>
    expect(body).toEqual({
      tiers: [
        {
          name: "MCP small",
          cpuRequest: 0.1,
          cpuLimit: null,
          memoryRequestMiB: 128,
          memoryLimitMiB: 512,
        },
        {
          name: "MCP medium",
          cpuRequest: 0.5,
          cpuLimit: null,
          memoryRequestMiB: null,
          memoryLimitMiB: null,
        },
      ],
    }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(await screen.findByText("MCP medium")).toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: "Edit MCP medium" }),
  );
  const editDialog = screen.getByRole("dialog", { name: "Edit tier" });
  const memory = within(editDialog).getByLabelText("Memory request (GiB)");
  expect(memory).toHaveValue(null);
  expect(memory).toHaveAttribute("placeholder", "1");
  await userEvent.clear(within(editDialog).getByLabelText("CPU request"));
  await userEvent.type(within(editDialog).getByLabelText("CPU request"), "1");
  expect(memory).toHaveAttribute("placeholder", "2");
  await userEvent.click(
    within(editDialog).getByRole("button", { name: "Save changes" }),
  );
  await waitFor(() =>
    expect(body).toMatchObject({
      tiers: [
        { name: "MCP small" },
        {
          name: "MCP medium",
          previousName: "MCP medium",
          cpuRequest: 1,
          memoryRequestMiB: null,
          memoryLimitMiB: null,
        },
      ],
    }),
  );
  expect(client.getQueryData(organizationKeys.agentRuntimeTiers())).toEqual(
    agentTiers,
  );
  client.clear();
});

it("keeps edits after a refused save and resets the shared editor when reopened", async () => {
  server.use(
    http.get(`${origin}/api/organization/mcp-runtime-tiers`, () =>
      HttpResponse.json(resolveMcpRuntimeTiers(null)),
    ),
    http.patch(`${origin}/api/organization/mcp-runtime-tiers`, () =>
      HttpResponse.json(
        {
          error: {
            message: "Tier names changed; reload and try again",
            type: "api_conflict_error",
          },
        },
        { status: 409 },
      ),
    ),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <McpRuntimeTiersBlock canEdit />
    </QueryClientProvider>,
  );
  await screen.findByRole("button", { name: "Edit S" });
  await userEvent.click(screen.getByRole("button", { name: "Edit S" }));
  const dialog = screen.getByRole("dialog", { name: "Edit tier" });
  const name = within(dialog).getByLabelText("Name");
  await userEvent.clear(name);
  await userEvent.type(name, "Unsaved tier");
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Save changes" }),
  );
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Tier names changed",
  );
  expect(name).toHaveValue("Unsaved tier");
  await userEvent.type(name, " edited");
  expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await userEvent.click(screen.getByRole("button", { name: "Edit S" }));
  expect(
    within(screen.getByRole("dialog", { name: "Edit tier" })).getByLabelText(
      "Name",
    ),
  ).toHaveValue("S");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  client.clear();
});
