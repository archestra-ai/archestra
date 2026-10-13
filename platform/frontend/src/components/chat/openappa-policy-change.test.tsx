import { archestraApiClient, type archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  OpenAppaPolicyChange,
  OpenAppaPolicyCompletion,
} from "./openappa-policy-change";

vi.mock("@/lib/auth/auth.query");
const server = setupServer();
let sync: archestraApiTypes.GetAppaGithubSyncResponses["200"];
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
  sync = {
    enabled: true,
    hasPolicy: true,
    validationDirectory: "",
    githubWebUrl: "https://github.com",
    source: null,
  };
  server.use(
    http.get("http://localhost:9000/api/openappa/github-sync", () =>
      HttpResponse.json(sync),
    ),
  );
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
function withQueries(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

test("shows a policy preview from the chat tool's text result", () => {
  render(
    <OpenAppaPolicyChange
      output={{
        content: JSON.stringify({
          stage: "preview",
          delivery: "revision",
          before: "[policy]\nversion = 2\n",
          after:
            '[policy]\nversion = 2\n[[policy.tool]]\nname = "example__search"\n',
        }),
      }}
    />,
  );

  expect(screen.getByLabelText("Policy diff")).toHaveTextContent(
    '+name = "example__search"',
  );
});

test("shows a reviewable policy diff and the pull request link", () => {
  render(
    <OpenAppaPolicyChange
      output={{
        structuredContent: {
          delivery: "pull_request",
          number: 17,
          url: "https://github.com/example/policies/pull/17",
          path: "guardrails/appa.toml",
          before: '[policy]\nversion = 2\nname = "old"\n',
          after: '[policy]\nversion = 2\nname = "new"\n',
        },
      }}
    />,
  );

  expect(
    screen.getByRole("link", { name: "Review pull request" }),
  ).toHaveAttribute("href", "https://github.com/example/policies/pull/17");
  expect(screen.getByLabelText("Policy diff")).toHaveTextContent(
    '-name = "old"',
  );
  expect(screen.getByLabelText("Policy diff")).toHaveTextContent(
    '+name = "new"',
  );
});

test("shows only the changed hunks when the backend sends its diff", () => {
  render(
    <OpenAppaPolicyChange
      output={{
        structuredContent: {
          stage: "preview",
          delivery: "revision",
          before: "a\nb\nc\nd\ne\nf\ng\nh\n",
          after: "a\nb\nc\nd\ne\nf\ng\nH\n",
          diff: "--- a/p\n+++ b/p\n@@ -5,4 +5,4 @@\n e\n f\n g\n-h\n+H\n",
        },
      }}
    />,
  );

  const diff = screen.getByLabelText("Policy diff");
  expect(diff).toHaveTextContent("@@ -5,4 +5,4 @@");
  expect(diff).not.toHaveTextContent(" a b c");
});

test("shows the whole policy when a first preview keeps the starter as is", () => {
  render(
    <OpenAppaPolicyChange
      output={{
        structuredContent: {
          stage: "preview",
          delivery: "revision",
          before: "[policy]\nversion = 2\n",
          after: "[policy]\nversion = 2\n",
        },
      }}
    />,
  );

  expect(screen.queryByLabelText("Policy diff")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Policy")).toHaveTextContent(
    "[policy] version = 2",
  );
});

const saved = {
  delivery: "revision",
  revision: 1,
  before: "starter",
  after: "starter",
  enforcement: { enabled: true },
  effective: { error: null, batteries: [{ status: "active" }] },
};

test("confirmed publication offers a return action without opening the diff", () => {
  render(
    withQueries(
      <OpenAppaPolicyCompletion output={{ structuredContent: saved }} />,
    ),
  );
  expect(screen.getByText("Saved revision 1")).toBeInTheDocument();
  expect(screen.getByText(/Enforcement confirmed on/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "View Guardrails" })).toHaveAttribute(
    "href",
    "/openappa",
  );
  expect(screen.queryByLabelText("Policy diff")).not.toBeInTheDocument();
});

test.each([
  { ...saved, enforcement: { enabled: false } },
  { ...saved, effective: { error: "Composition failed", batteries: [] } },
  {
    ...saved,
    effective: { error: null, batteries: [{ status: "missing_credentials" }] },
  },
  { ...saved, enforcement: undefined },
  { ...saved, effective: undefined },
])("saved but unconfirmed results do not claim active protection", (output) => {
  render(withQueries(<OpenAppaPolicyCompletion output={output} />));
  expect(screen.getByText("Saved revision 1")).toBeInTheDocument();
  expect(
    screen.queryByText(/Enforcement confirmed on/),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Check policy" })).toHaveAttribute(
    "href",
    "/openappa/policy",
  );
});

test.each([
  { ...saved, stage: "preview" },
  { ...saved, delivery: "pull_request", number: 4 },
  { ...saved, revision: 0 },
])("preview and pending PR do not appear as a saved local policy", (output) => {
  const { container } = render(
    withQueries(<OpenAppaPolicyCompletion output={output} />),
  );
  expect(container).toBeEmptyDOMElement();
});

test("published PR stays reviewable outside collapsed tool details", () => {
  render(
    withQueries(
      <OpenAppaPolicyCompletion
        output={{
          delivery: "pull_request",
          number: 17,
          url: "https://github.com/example/policies/pull/17",
          before: "old",
          after: "new",
        }}
      />,
    ),
  );
  expect(
    screen.getByRole("link", { name: "Review pull request" }),
  ).toHaveAttribute("href", "https://github.com/example/policies/pull/17");
  expect(screen.queryByText(/Saved revision/)).not.toBeInTheDocument();
});

test("a locally saved policy suggests GitHub sync to admins who have not set it up", async () => {
  render(
    withQueries(
      <OpenAppaPolicyCompletion output={{ structuredContent: saved }} />,
    ),
  );
  const link = await screen.findByRole("link", { name: "Set up GitHub sync" });
  expect(link).toHaveAttribute(
    "href",
    "/settings/guardrails?setup=github-sync",
  );
  // A new tab keeps the conversation in place.
  expect(link).toHaveAttribute("target", "_blank");
});

test.each([
  [
    "sync already has a repository",
    () => {
      sync = {
        ...sync,
        source: {
          organizationId: "org",
          repo: "example/policies",
          ref: "main",
          path: "appa.toml",
          interval: "1h",
          githubPatId: null,
          githubAppConfigId: null,
          revision: "revision",
          sourceCommit: null,
          setupPullRequestNumber: null,
          lastSyncedAt: null,
          lastSyncError: null,
          declarationsPendingPublish: false,
          heldContentHash: null,
          heldSourceCommit: null,
          heldReasons: [],
        },
      };
    },
  ],
  [
    "sync is off on the server",
    () => {
      sync = { ...sync, enabled: false };
    },
  ],
  [
    "the user cannot manage settings",
    () => {
      vi.mocked(useHasPermissions).mockImplementation(
        (permissions) =>
          ({
            data:
              permissions.organizationSettings?.every(
                (action) => action === "read",
              ) ?? false,
          }) as ReturnType<typeof useHasPermissions>,
      );
    },
  ],
])("no GitHub sync tip when %s", async (_name, arrange) => {
  arrange();
  let requested = false;
  server.use(
    http.get("http://localhost:9000/api/openappa/github-sync", () => {
      requested = true;
      return HttpResponse.json(sync);
    }),
  );
  render(
    withQueries(
      <OpenAppaPolicyCompletion output={{ structuredContent: saved }} />,
    ),
  );
  await vi.waitFor(() => expect(requested).toBe(true));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(
    screen.queryByRole("link", { name: "Set up GitHub sync" }),
  ).not.toBeInTheDocument();
  expect(screen.getByText("Saved revision 1")).toBeInTheDocument();
});
