import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { useRouter } from "next/navigation";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from "vitest";
import { Button } from "@/components/ui/button";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useValidation, ValidationProvider } from "./validation-context";

vi.mock("@/lib/auth/auth.query");
vi.mock("sonner");
vi.mock("next/navigation");
const endpoint = "http://localhost:9000/api/openappa/policy-tests";
const server = setupServer();
const original = {
  source: "local",
  version: "v1",
  sourceCommit: null,
  directory: "traces",
  activeDirectory: "traces",
  error: null,
  files: [{ path: "one.appa", content: "mcp/files/read {}\nexpect allow\n" }],
};
let client: QueryClient;
function session(id: string, organization: string) {
  vi.mocked(useSession).mockReturnValue({
    data: {
      session: { id, activeOrganizationId: organization },
      user: { id: "user" },
    },
  } as ReturnType<typeof useSession>);
}
function Draft() {
  const suite = useValidation();
  return (
    <>
      <textarea
        aria-label="Content"
        {...suite.form.register("files.0.content")}
      />
      {suite.files.length > 1 && (
        <textarea
          aria-label="Second content"
          {...suite.form.register("files.1.content")}
        />
      )}
      <span data-testid="files">{JSON.stringify(suite.files)}</span>
      <span data-testid="ids">
        {JSON.stringify(suite.fields.map((field) => field.id))}
      </span>
      <Button onClick={() => suite.deleteFiles([suite.fields[0].id])}>
        Delete first
      </Button>
      <Button
        onClick={() =>
          suite.createFile(
            { path: "created.appa", content: "created content" },
            () => undefined,
            () => undefined,
          )
        }
      >
        Create
      </Button>
      <span data-testid="id">{suite.fields[0]?.id}</span>
      <span data-testid="baseline">{suite.baseline.version}</span>
      <span data-testid="dirty">{String(suite.dirty)}</span>
      <span data-testid="source-changed">{String(suite.sourceChanged)}</span>
      <a href="/openappa">Leave</a>
      <Button onClick={() => suite.save(0)}>Save</Button>
    </>
  );
}
function mount() {
  return render(
    <QueryClientProvider client={client}>
      <ValidationProvider>
        <Draft />
      </ValidationProvider>
    </QueryClientProvider>,
  );
}
function deferWrite(response: typeof original) {
  let finish: () => void = () => undefined;
  let began: () => void = () => undefined;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  server.use(
    http.put(endpoint, async () => {
      began();
      await pending;
      return HttpResponse.json(response);
    }),
  );
  return { started, finish };
}
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  session("session-one", "org-one");
  vi.mocked(useRouter).mockReturnValue({
    push: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
  server.use(
    http.get(endpoint, () => HttpResponse.json(original)),
    http.get(`${endpoint}/runs`, () => HttpResponse.json([])),
    http.post(`${endpoint}/inspect`, () => HttpResponse.json({ files: [] })),
  );
});
afterEach(() => {
  client.clear();
  server.resetHandlers();
});
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

test("route unmount retains unsaved text and draft identity without changing authoritative data", async () => {
  const first = mount();
  const input = await screen.findByRole("textbox", { name: "Content" });
  const id = screen.getByTestId("id").textContent;
  fireEvent.change(input, { target: { value: "unsaved replay" } });
  first.unmount();
  mount();
  expect(await screen.findByRole("textbox", { name: "Content" })).toHaveValue(
    "unsaved replay",
  );
  expect(screen.getByTestId("id")).toHaveTextContent(id ?? "");
  expect(screen.getByTestId("dirty")).toHaveTextContent("true");
  expect(client.getQueryData(["openappa-policy-tests", "active"])).toEqual(
    original,
  );
  const retained = client
    .getQueryCache()
    .find({ queryKey: ["openappa-validation-draft"] });
  expect(retained?.meta?.persist).not.toBe(true);
});

test("restored draft keeps its original version when the source changes", async () => {
  const first = mount();
  fireEvent.change(await screen.findByRole("textbox", { name: "Content" }), {
    target: { value: "old-version draft" },
  });
  first.unmount();
  client.setQueryData(["openappa-policy-tests", "active"], {
    ...original,
    version: "v2",
  });
  server.use(
    http.get(endpoint, () => HttpResponse.json({ ...original, version: "v2" })),
  );
  mount();
  expect(await screen.findByRole("textbox", { name: "Content" })).toHaveValue(
    "old-version draft",
  );
  expect(screen.getByTestId("baseline")).toHaveTextContent("v1");
  expect(screen.getByTestId("source-changed")).toHaveTextContent("true");
});

test("explicit discard removes the retained draft before navigation", async () => {
  const first = mount();
  fireEvent.change(await screen.findByRole("textbox", { name: "Content" }), {
    target: { value: "discard me" },
  });
  fireEvent.click(screen.getByRole("link", { name: "Leave" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Discard changes" }),
  );
  await waitFor(() =>
    expect(screen.getByTestId("dirty")).toHaveTextContent("false"),
  );
  first.unmount();
  mount();
  expect(await screen.findByRole("textbox", { name: "Content" })).toHaveValue(
    original.files[0].content,
  );
});

test("drafts do not cross sessions or organizations", async () => {
  const first = mount();
  fireEvent.change(await screen.findByRole("textbox", { name: "Content" }), {
    target: { value: "private draft" },
  });
  first.unmount();
  session("session-two", "org-one");
  const second = mount();
  expect(await screen.findByRole("textbox", { name: "Content" })).toHaveValue(
    original.files[0].content,
  );
  second.unmount();
  session("session-one", "org-two");
  mount();
  expect(await screen.findByRole("textbox", { name: "Content" })).toHaveValue(
    original.files[0].content,
  );
});

test("Save completion reconciles its retained draft after route unmount", async () => {
  const next = {
    ...original,
    version: "v2",
    files: [{ ...original.files[0], content: "saved content" }],
  };
  const { started, finish } = deferWrite(next);
  const first = mount();
  fireEvent.change(await screen.findByRole("textbox", { name: "Content" }), {
    target: { value: "saved content" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await started;
  first.unmount();
  server.use(http.get(endpoint, () => HttpResponse.json(next)));
  finish();
  await waitFor(() =>
    expect(client.getQueryData(["openappa-policy-tests", "active"])).toEqual(
      next,
    ),
  );
  mount();
  expect(await screen.findByRole("textbox", { name: "Content" })).toHaveValue(
    "saved content",
  );
  expect(screen.getByTestId("dirty")).toHaveTextContent("false");
  expect(screen.getByTestId("source-changed")).toHaveTextContent("false");
});

test("late Save completion preserves a newer draft created after returning", async () => {
  const next = {
    ...original,
    version: "v2",
    files: [{ ...original.files[0], content: "submitted content" }],
  };
  const { started, finish } = deferWrite(next);
  const first = mount();
  fireEvent.change(await screen.findByRole("textbox", { name: "Content" }), {
    target: { value: "submitted content" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await started;
  first.unmount();
  const second = mount();
  fireEvent.change(await screen.findByRole("textbox", { name: "Content" }), {
    target: { value: "newer edit" },
  });
  server.use(http.get(endpoint, () => HttpResponse.json(next)));
  finish();
  await waitFor(() =>
    expect(client.getQueryData(["openappa-policy-tests", "active"])).toEqual(
      next,
    ),
  );
  second.unmount();
  mount();
  expect(await screen.findByRole("textbox", { name: "Content" })).toHaveValue(
    "newer edit",
  );
  expect(screen.getByTestId("baseline")).toHaveTextContent("v1");
  expect(screen.getByTestId("source-changed")).toHaveTextContent("true");
});

test("Save completion reconciles an unchanged draft remounted while the request is pending", async () => {
  const next = {
    ...original,
    version: "v2",
    files: [{ ...original.files[0], content: "submitted content" }],
  };
  const { started, finish } = deferWrite(next);
  const first = mount();
  fireEvent.change(await screen.findByRole("textbox", { name: "Content" }), {
    target: { value: "submitted content" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await started;
  first.unmount();
  mount();
  const id = (await screen.findByTestId("id")).textContent;
  server.use(http.get(endpoint, () => HttpResponse.json(next)));
  finish();
  await waitFor(() =>
    expect(screen.getByTestId("dirty")).toHaveTextContent("false"),
  );
  expect(screen.getByTestId("source-changed")).toHaveTextContent("false");
  expect(screen.getByTestId("id")).toHaveTextContent(id ?? "");
  expect(screen.getByRole("textbox", { name: "Content" })).toHaveValue(
    "submitted content",
  );
});

test.each([
  "save",
  "delete",
  "create",
])("%s completion rebases unrelated drafts across pending remounts", async (operation) => {
  const originalFiles = [
    original.files[0],
    { path: "two.appa", content: "original second" },
  ];
  const initial = { ...original, files: originalFiles };
  const next = {
    ...initial,
    version: "v2",
    files:
      operation === "delete"
        ? [originalFiles[1]]
        : operation === "create"
          ? [
              ...originalFiles,
              { path: "created.appa", content: "created content" },
            ]
          : [
              { ...originalFiles[0], content: "submitted content" },
              originalFiles[1],
            ],
  };
  server.use(http.get(endpoint, () => HttpResponse.json(initial)));
  const { started, finish } = deferWrite(next);
  const first = mount();
  await screen.findByRole("textbox", { name: "Content" });
  if (operation !== "create") {
    fireEvent.change(screen.getByRole("textbox", { name: "Second content" }), {
      target: { value: "preserved second draft" },
    });
    if (operation === "save")
      fireEvent.change(screen.getByRole("textbox", { name: "Content" }), {
        target: { value: "submitted content" },
      });
  }
  const ids = JSON.parse(screen.getByTestId("ids").textContent ?? "[]");
  fireEvent.click(
    screen.getByRole("button", {
      name:
        operation === "delete"
          ? "Delete first"
          : operation === "create"
            ? "Create"
            : "Save",
    }),
  );
  await started;
  first.unmount();
  mount();
  await screen.findByRole("textbox", { name: "Content" });
  server.use(http.get(endpoint, () => HttpResponse.json(next)));
  finish();
  await waitFor(() =>
    expect(screen.getByTestId("baseline")).toHaveTextContent("v2"),
  );
  expect(screen.getByTestId("source-changed")).toHaveTextContent("false");
  if (operation === "create") {
    expect(screen.getByTestId("files")).toHaveTextContent("created.appa");
    expect(screen.getByTestId("dirty")).toHaveTextContent("false");
  } else {
    expect(
      screen.getByRole("textbox", {
        name: operation === "delete" ? "Content" : "Second content",
      }),
    ).toHaveValue("preserved second draft");
    const retainedIds = JSON.parse(
      screen.getByTestId("ids").textContent ?? "[]",
    );
    expect(retainedIds[operation === "delete" ? 0 : 1]).toBe(ids[1]);
    expect(screen.getByTestId("dirty")).toHaveTextContent("true");
    if (operation === "delete")
      expect(screen.getByTestId("files")).not.toHaveTextContent("one.appa");
  }
});

test.each([
  "save",
  "delete",
])("%s completion does not revive explicitly discarded unrelated drafts", async (operation) => {
  const initial = {
    ...original,
    files: [
      original.files[0],
      { path: "two.appa", content: "original second" },
    ],
  };
  const next = {
    ...initial,
    version: "v2",
    files:
      operation === "delete"
        ? [initial.files[1]]
        : [
            { ...initial.files[0], content: "submitted content" },
            initial.files[1],
          ],
  };
  server.use(http.get(endpoint, () => HttpResponse.json(initial)));
  const { started, finish } = deferWrite(next);
  const first = mount();
  fireEvent.change(
    await screen.findByRole("textbox", { name: "Second content" }),
    { target: { value: "discarded second draft" } },
  );
  if (operation === "save")
    fireEvent.change(screen.getByRole("textbox", { name: "Content" }), {
      target: { value: "submitted content" },
    });
  fireEvent.click(
    screen.getByRole("button", {
      name: operation === "save" ? "Save" : "Delete first",
    }),
  );
  await started;
  fireEvent.click(screen.getByRole("link", { name: "Leave" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Discard changes" }),
  );
  await waitFor(() =>
    expect(screen.getByTestId("dirty")).toHaveTextContent("false"),
  );
  first.unmount();
  server.use(http.get(endpoint, () => HttpResponse.json(next)));
  finish();
  await waitFor(() =>
    expect(client.getQueryData(["openappa-policy-tests", "active"])).toEqual(
      next,
    ),
  );
  mount();
  expect(
    await screen.findByRole("textbox", {
      name: operation === "delete" ? "Content" : "Second content",
    }),
  ).toHaveValue("original second");
  expect(screen.getByTestId("dirty")).toHaveTextContent("false");
  expect(screen.getByTestId("source-changed")).toHaveTextContent("false");
});
