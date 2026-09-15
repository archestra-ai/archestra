import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from "vitest";
import { authQueryKeys } from "@/lib/auth/auth.query";
import { GuardrailsPolicyEditor } from "./guardrails-policy-editor";

vi.mock("@/components/editor");
vi.mock("sonner");
const origin = "http://localhost:9000";
const url = `${origin}/api/guardrails-policy`;
const content = "[policy]\nversion = 2\n";
const policy = {
  organizationId: "org",
  revision: 1,
  content,
  contentHash: "hash",
  updatedBy: null,
  updatedAt: null,
};
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl: origin });
  server.use(
    http.get(url, () => HttpResponse.json(policy)),
    http.get(`${origin}/api/user/permissions`, () =>
      HttpResponse.json({ toolPolicy: ["read", "update"] }),
    ),
  );
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(authQueryKeys.session(), {
    user: { id: "user" },
    session: { id: "session" },
  });
  render(
    <QueryClientProvider client={client}>
      <GuardrailsPolicyEditor />
    </QueryClientProvider>,
  );
  return client;
}

test("validates edits inline, saves the exact text and revision, and becomes clean", async () => {
  let submitted: unknown;
  server.use(
    http.post(`${url}/validate`, () =>
      HttpResponse.json({ valid: false, errors: ["Unknown trust rank"] }),
    ),
    http.put(url, async ({ request }) => {
      submitted = await request.json();
      return HttpResponse.json({
        ...policy,
        content: `${content}# edited`,
        revision: 2,
      });
    }),
  );
  mount();
  const editor = await screen.findByRole("textbox", {
    name: "Organization guardrails policy",
  });
  await screen.findByRole("button", { name: "Validate" });
  fireEvent.change(editor, { target: { value: `${content}# edited` } });
  fireEvent.click(screen.getByRole("button", { name: "Validate" }));
  expect(await screen.findByText("Unknown trust rank")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Save & apply" }));
  await screen.findByText("Revision 2");
  expect(submitted).toEqual({
    content: `${content}# edited`,
    expectedRevision: 1,
  });
  expect(screen.getByRole("button", { name: "Save & apply" })).toBeDisabled();
});

test("preserves local edits when another writer updates the policy and rejects a stale save", async () => {
  server.use(
    http.put(url, () =>
      HttpResponse.json(
        {
          error: {
            message: "Policy changed; reload before saving",
            type: "conflict",
          },
        },
        { status: 409 },
      ),
    ),
  );
  const client = mount();
  const editor = await screen.findByRole("textbox", {
    name: "Organization guardrails policy",
  });
  await screen.findByRole("button", { name: "Save & apply" });
  fireEvent.change(editor, { target: { value: `${content}# my change` } });
  client.setQueryData(["guardrails-policy"], {
    ...policy,
    revision: 2,
    content: `${content}# other change`,
  });
  await screen.findByText(/A newer revision is available/);
  expect(editor).toHaveValue(`${content}# my change`);
  fireEvent.click(screen.getByRole("button", { name: "Save & apply" }));
  expect(
    await screen.findByText("Policy changed; reload before saving"),
  ).toBeInTheDocument();
  expect(editor).toHaveValue(`${content}# my change`);
});

test("read-only users can inspect the policy without editing controls", async () => {
  server.use(
    http.get(`${origin}/api/user/permissions`, () =>
      HttpResponse.json({ toolPolicy: ["read"] }),
    ),
  );
  mount();
  const editor = await screen.findByRole("textbox", {
    name: "Organization guardrails policy",
  });
  await waitFor(() => expect(editor).toHaveAttribute("readonly"));
  expect(
    screen.queryByRole("button", { name: "Save & apply" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Validate" }),
  ).not.toBeInTheDocument();
});
