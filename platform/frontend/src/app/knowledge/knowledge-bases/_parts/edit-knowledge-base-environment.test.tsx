import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useDefaultEnvironment } from "@/lib/organization.query";
import { EditKnowledgeBaseDialog } from "./edit-knowledge-base-dialog";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/config/config.query");
vi.mock("sonner");

const server = setupServer();
const environmentId = "0bccb937-4e64-460c-b357-3bf87263de0e";
const knowledgeBase = {
  id: "2841cbb7-4f83-47d5-a86e-3193755bed18",
  name: "Policies",
  description: null,
  uploadedFilesEnvironmentId: null,
};

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => server.resetHandlers());
beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
  vi.mocked(useFeature).mockReturnValue(false);
  vi.mocked(useSession).mockReturnValue({ data: null } as ReturnType<
    typeof useSession
  >);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
  vi.mocked(useDefaultEnvironment).mockReturnValue({
    name: "Default",
    description: null,
    namespace: null,
    networkPolicy: null,
    validationRegex: null,
    trustedImageRegistries: null,
  });
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  server.use(
    http.get(
      "http://localhost:9000/api/resource-permissions/knowledgeBase/:scope",
      () =>
        HttpResponse.json({
          resource: "knowledgeBase",
          scope: knowledgeBase.id,
          name: "Policies",
          revision: 1,
          grants: [],
          inheritedGrants: [],
          actorSubjects: [],
          effectiveActions: ["read", "update"],
        }),
    ),
    http.get("http://localhost:9000/api/environments", () =>
      HttpResponse.json({
        environments: [{ id: environmentId, name: "Support", canDeploy: true }],
      }),
    ),
  );
});

it("edits the uploaded files environment through the knowledge base API without changing file permissions", async () => {
  const saved: unknown[] = [];
  server.use(
    http.put(
      "http://localhost:9000/api/knowledge-bases/:id",
      async ({ request }) => {
        const body = await request.json();
        saved.push(body);
        return HttpResponse.json({ ...knowledgeBase, ...(body as object) });
      },
    ),
  );
  const onOpenChange = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <EditKnowledgeBaseDialog
        knowledgeBase={knowledgeBase}
        open
        onOpenChange={onOpenChange}
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  const picker = screen.getByRole("combobox", {
    name: "Uploaded files environment",
  });
  await waitFor(() => expect(picker).toBeEnabled());
  await user.click(picker);
  await user.click(await screen.findByRole("option", { name: "Support" }));
  await user.click(screen.getByRole("button", { name: "Save Changes" }));
  await waitFor(() =>
    expect(saved).toEqual([
      {
        name: "Policies",
        description: null,
        labels: [],
        uploadedFilesEnvironmentId: environmentId,
      },
    ]),
  );
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
});

it("renames a knowledge base without reassigning its unchanged restricted environment", async () => {
  const saved: unknown[] = [];
  server.use(
    http.get("http://localhost:9000/api/environments", () =>
      HttpResponse.json({
        environments: [
          { id: environmentId, name: "Support", canDeploy: false },
        ],
      }),
    ),
    http.put(
      "http://localhost:9000/api/knowledge-bases/:id",
      async ({ request }) => {
        const body = await request.json();
        saved.push(body);
        if (Object.hasOwn(body as object, "uploadedFilesEnvironmentId")) {
          return HttpResponse.json(
            { message: "Cannot assign this environment" },
            { status: 403 },
          );
        }
        return HttpResponse.json({ ...knowledgeBase, ...(body as object) });
      },
    ),
  );
  const onOpenChange = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <EditKnowledgeBaseDialog
        knowledgeBase={{
          ...knowledgeBase,
          uploadedFilesEnvironmentId: environmentId,
        }}
        open
        onOpenChange={onOpenChange}
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.clear(screen.getByRole("textbox", { name: "Name" }));
  await user.type(
    screen.getByRole("textbox", { name: "Name" }),
    "Updated policies",
  );
  await user.click(screen.getByRole("button", { name: "Save Changes" }));
  await waitFor(() =>
    expect(saved).toEqual([
      { name: "Updated policies", description: null, labels: [] },
    ]),
  );
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
});
