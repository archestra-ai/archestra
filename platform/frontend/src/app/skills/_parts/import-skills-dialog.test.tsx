import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { ImportSkillsDialog } from "./import-skills-dialog";

const API = "http://localhost:9000";

const SELF_MANAGED_TOKEN = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Acme GitLab",
  provider: "gitlab",
  kind: "gitlab_token",
  webUrl: "https://gitlab.acme.example",
  createdAt: "2026-10-01T00:00:00.000Z",
};

let credentials: (typeof SELF_MANAGED_TOKEN)[] = [];
const requests: { path: string; body: unknown }[] = [];

const server = setupServer(
  http.get(`${API}/api/git-credentials`, () => HttpResponse.json(credentials)),
  http.get(`${API}/api/git-credentials/:id/repositories`, () =>
    HttpResponse.json([]),
  ),
  http.get(`${API}/api/resource-permissions/skill/creation-subjects`, () =>
    HttpResponse.json([]),
  ),
  http.post(`${API}/api/git-credentials/gitlab`, async ({ request }) => {
    const body = (await request.json()) as { name: string; gitlabUrl: string };
    requests.push({ path: "create-token", body });
    const created = {
      ...SELF_MANAGED_TOKEN,
      id: "22222222-2222-4222-8222-222222222222",
      name: body.name,
      webUrl: body.gitlabUrl,
    };
    credentials = [...credentials, created];
    return HttpResponse.json(created);
  }),
  http.post(`${API}/api/skills/github/discover`, async ({ request }) => {
    requests.push({ path: "discover", body: await request.json() });
    return HttpResponse.json({
      repoUrl: "https://gitlab.acme.example/platform/agents/skills",
      ref: "main",
      skills: [
        {
          skillPath: "skills/pdf",
          name: "PDF reader",
          description: "Reads PDFs",
          compatibility: null,
          allowedTools: null,
          templated: false,
          fileCount: 1,
          exists: false,
        },
      ],
    });
  }),
  http.post(`${API}/api/skills/github/import`, async ({ request }) => {
    requests.push({ path: "import", body: await request.json() });
    return HttpResponse.json({ created: [], skipped: [], skippedFiles: [] });
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
  credentials = [];
  requests.length = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.mocked(useRouter).mockReturnValue({
    push: vi.fn(),
    replace: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(usePathname).mockReturnValue("/skills/new");
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as ReturnType<typeof useSearchParams>,
  );
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "user-1" } },
  } as unknown as ReturnType<typeof useSession>);
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

describe("ImportSkillsDialog", () => {
  it("reads a self-managed GitLab project with the saved token", async () => {
    credentials = [SELF_MANAGED_TOKEN];
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /^GitLab/ }));
    expect(
      await screen.findByRole("radio", { name: /Acme GitLab/ }),
    ).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(
      await screen.findByRole("textbox", { name: "Repository URL" }),
      "platform/agents/skills",
    );
    await user.click(screen.getByRole("button", { name: "Find skills" }));

    await screen.findByText("PDF reader");
    await user.click(screen.getByRole("button", { name: /^Import(?: \(|$)/ }));
    await waitFor(() =>
      expect(requests.map((entry) => entry.path)).toContain("import"),
    );

    const credential = {
      provider: "gitlab",
      gitlabTokenId: SELF_MANAGED_TOKEN.id,
    };
    expect(requests.find((entry) => entry.path === "discover")?.body).toEqual({
      repoUrl: "https://gitlab.acme.example/platform/agents/skills",
      ...credential,
    });
    expect(
      requests.find((entry) => entry.path === "import")?.body,
    ).toMatchObject({
      repoUrl: "https://gitlab.acme.example/platform/agents/skills",
      ...credential,
      skillPaths: ["skills/pdf"],
    });
  });

  it("saves a GitLab token added inline and reads with it", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /^GitLab/ }));
    await user.click(
      await screen.findByRole("radio", { name: /Add a GitLab token/ }),
    );
    await user.type(screen.getByLabelText("Token"), "glpat-secret");
    await user.click(screen.getByRole("button", { name: "Save token" }));

    expect(
      await screen.findByRole("radio", { name: /^GitLab$/ }),
    ).toBeChecked();
    expect(requests).toEqual([
      {
        path: "create-token",
        body: {
          name: "GitLab",
          gitlabUrl: "https://gitlab.com",
          token: "glpat-secret",
        },
      },
    ]);

    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(
      await screen.findByRole("textbox", { name: "Repository URL" }),
      "acme/skills",
    );
    await user.click(screen.getByRole("button", { name: "Find skills" }));
    await waitFor(() =>
      expect(requests.find((entry) => entry.path === "discover")?.body).toEqual(
        {
          repoUrl: "https://gitlab.com/acme/skills",
          provider: "gitlab",
          gitlabTokenId: "22222222-2222-4222-8222-222222222222",
        },
      ),
    );
  });
});

function renderDialog() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ImportSkillsDialog open onOpenChange={vi.fn()} />
    </QueryClientProvider>,
  );
}
