import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { makeAgent } from "@/mocks/data/agents";
import { sessionSeed } from "@/mocks/data/auth";
import { organizationSeed } from "@/mocks/data/organization";
import { handlers } from "@/mocks/handlers";
import { AgentSettingsView } from "./settings-view";

vi.mock("next/navigation");
vi.mock("sonner");
vi.mock("@/components/agents/system-prompt-editor", () => ({
  SystemPromptEditor: () => <textarea aria-label="Instructions" />,
}));
const server = setupServer(...handlers);
const clients: QueryClient[] = [];
beforeAll(() => {
  archestraApiClient.setConfig({ baseUrl: window.location.origin });
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  for (const client of clients) client.clear();
  clients.length = 0;
  server.resetHandlers();
});
afterAll(() => server.close());

it.each([
  true,
  false,
])("matches detail-page editing capabilities for builtIn=%s", async (builtIn) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  client.setQueryData(["auth", "session"], sessionSeed);
  client.setQueryData(["organization", "details"], organizationSeed);
  render(
    <QueryClientProvider client={client}>
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle className="sr-only">Agent settings</DialogTitle>
          <AgentSettingsView
            agent={makeAgent({
              builtIn,
              name: "Policy Assistant",
              scope: "org",
              accessAllTools: false,
            })}
            instructions="Instructions"
            onInstructionsChange={vi.fn()}
            instructionsDirty={false}
            onSaveInstructions={vi.fn()}
            onDiscardInstructions={vi.fn()}
            isSavingInstructions={false}
            instructionsJustSaved={false}
            notice={null}
            onDismissNotice={vi.fn()}
            highlightCatalogId={null}
            allKnowledgeBases={[]}
            allConnectors={[]}
            onAddTools={vi.fn()}
            onChooseTools={vi.fn()}
            onEditSubagents={vi.fn()}
            onEditKnowledge={vi.fn()}
          />
        </DialogContent>
      </Dialog>
    </QueryClientProvider>,
  );
  expect(
    screen.getByRole("textbox", { name: "Instructions" }),
  ).toBeInTheDocument();
  expect(
    await screen.findByRole("button", { name: "Add tools" }),
  ).toBeInTheDocument();
  expect(
    screen
      .getByRole("button", {
        name: builtIn ? "Icon" : /Choose icon|Change icon/,
      })
      .hasAttribute("disabled"),
  ).toBe(builtIn);
  for (const label of ["Rename", "Add subagents"]) {
    expect(!!screen.queryByRole("button", { name: label })).toBe(!builtIn);
  }
  expect(!!screen.queryByText("Knowledge", { exact: true })).toBe(!builtIn);
  expect(!!screen.queryByText("Shared with organization")).toBe(!builtIn);
  expect(!!screen.queryByText(/Created by/)).toBe(!builtIn);
  expect(!!screen.queryByRole("img", { name: "Built-in agent" })).toBe(builtIn);
  expect(!!screen.queryByRole("tablist", { name: "Tool access" })).toBe(
    !builtIn,
  );
});
