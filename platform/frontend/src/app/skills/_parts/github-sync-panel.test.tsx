import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");

import { useHasPermissions } from "@/lib/auth/auth.query";
import { GithubSyncPanel, type SkillDetail } from "./github-sync-panel";

const API = "http://localhost:9000";

const TOKEN = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Acme GitLab",
  provider: "gitlab",
  kind: "gitlab_token",
  webUrl: "https://gitlab.acme.example",
  createdAt: "2026-10-01T00:00:00.000Z",
};

const SKILL = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "pdf-reader",
  sourceProvider: "gitlab",
  sourceOrigin: "https://gitlab.acme.example",
  sourceRef: "platform/agents/skill-hub@abc123:skills/pdf",
  githubSyncRef: "main",
  githubSyncInterval: "1d",
  lastSyncedAt: "2026-10-12T00:00:00.000Z",
  lastSyncError: null,
  gitlabTokenId: TOKEN.id,
  githubAppConfigId: null,
  githubPatId: null,
} as unknown as SkillDetail;

const patches: unknown[] = [];

const server = setupServer(
  http.get(`${API}/api/git-credentials`, () => HttpResponse.json([TOKEN])),
  http.get(`${API}/api/git-credentials/:id/repositories`, () =>
    HttpResponse.json([]),
  ),
  http.patch(`${API}/api/skills/:id/github-sync`, async ({ request }) => {
    patches.push(await request.json());
    return HttpResponse.json(SKILL);
  }),
);

beforeAll(() => {
  archestraApiClient.setConfig({ baseUrl: API });
  server.listen({ onUnhandledRequest: "error" });
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
});
beforeEach(() => {
  patches.length = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
  } as unknown as ReturnType<typeof useHasPermissions>);
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

describe("GithubSyncPanel", () => {
  it("edits the source in the setup steps, opened on what the skill reads", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole("button", { name: "Edit source" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit source" });
    expect(await within(dialog).findByText("Acme GitLab")).toBeVisible();
    expect(
      within(dialog).getByRole("textbox", { name: "Repository URL" }),
    ).toHaveValue("https://gitlab.acme.example/platform/agents/skill-hub");
    expect(within(dialog).getByLabelText("Branch")).toHaveValue("main");
    const folder = within(dialog).getByLabelText("Folder");
    expect(folder).toHaveValue("skills/pdf");

    await user.clear(folder);
    await user.type(folder, "skills/reader");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({
      interval: "1d",
      source: {
        provider: "gitlab",
        gitlabTokenId: TOKEN.id,
        repoUrl:
          "https://gitlab.acme.example/platform/agents/skill-hub/-/tree/main",
        skillPath: "skills/reader",
      },
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Edit source" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("sends a new schedule alone when the source stays", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole("button", { name: "Edit source" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit source" });
    await user.click(
      await within(dialog).findByRole("combobox", { name: "Keep in sync" }),
    );
    await user.click(await screen.findByRole("option", { name: "Every hour" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    // Nothing to fetch again: the skill keeps its content.
    await waitFor(() => expect(patches).toEqual([{ interval: "1h" }]));
  });
});

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <GithubSyncPanel
        skill={SKILL}
        sourceRepo="https://gitlab.acme.example/platform/agents/skill-hub"
      />
    </QueryClientProvider>,
  );
}
