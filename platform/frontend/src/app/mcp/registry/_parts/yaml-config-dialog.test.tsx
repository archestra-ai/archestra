import { archestraApiClient } from "@archestra/shared";
import type { EditorProps } from "@monaco-editor/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import {
  useHasPermissions,
  useScopedCapabilities,
} from "@/lib/auth/auth.query";
import { YamlConfigContent } from "./yaml-config-dialog";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");
// Monaco owns its DOM outside React. Exercise the real editor wrapper and
// form/query state, replacing only that external rendering boundary.
vi.mock("@monaco-editor/react", () => ({
  Editor: ({ value, onChange, options }: EditorProps) => (
    <textarea
      aria-label="Deployment YAML"
      value={value}
      readOnly={options?.readOnly}
      onChange={(event) => onChange?.(event.target.value, undefined as never)}
    />
  ),
}));

const original = "apiVersion: apps/v1\nkind: Deployment\nspec: {}\n";
const saved: unknown[] = [];
let resetCount = 0;
const server = setupServer(
  http.get(
    "http://localhost:9000/api/internal_mcp_catalog/catalog-1/deployment-yaml-preview",
    () => HttpResponse.json({ yaml: original }),
  ),
  http.post(
    "http://localhost:9000/api/internal_mcp_catalog/validate-deployment-yaml",
    async ({ request }) => {
      const { yaml } = (await request.json()) as { yaml: string };
      const errors = yaml === "invalid" ? ["spec is required"] : [];
      return HttpResponse.json({
        valid: errors.length === 0,
        errors,
        warnings: [],
      });
    },
  ),
  http.post(
    "http://localhost:9000/api/internal_mcp_catalog/catalog-1/reset-deployment-yaml",
    () => {
      resetCount++;
      return HttpResponse.json({ yaml: original });
    },
  ),
  http.put(
    "http://localhost:9000/api/internal_mcp_catalog/catalog-1",
    async ({ request }) => {
      saved.push(await request.json());
      return HttpResponse.json({ id: "catalog-1" });
    },
  ),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
beforeEach(() => {
  vi.mocked(useScopedCapabilities).mockReturnValue({
    data: ["read", "use", "update", "delete", "manage-permissions"].map(
      (action) => ({ resource: "mcpRegistry", scope: "*", action }),
    ),
  } as ReturnType<typeof useScopedCapabilities>);
  saved.length = 0;
  resetCount = 0;
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
});

function renderEditor() {
  const close = vi.fn();
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <YamlConfigContent
        item={{ id: "catalog-1", serverType: "local" } as never}
        onClose={close}
        hideHeader
      />
    </QueryClientProvider>,
  );
  return close;
}

describe("deployment YAML workflow", () => {
  it("keeps guidance out of the workspace until Help is opened, and saves an edited draft", async () => {
    const close = renderEditor();
    const editor = await screen.findByRole("textbox", {
      name: "Deployment YAML",
    });
    expect(screen.queryByText("Template values")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "YAML help" }));
    expect(screen.getByText("Template values")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    const edited = `${original}# trusted admin edit\n`;
    fireEvent.change(editor, { target: { value: edited } });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save Changes" }),
      ).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() =>
      expect(saved).toEqual([{ deploymentSpecYaml: edited }]),
    );
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it("places validation feedback above the editor and clears it after a correction", async () => {
    renderEditor();
    const editor = await screen.findByRole("textbox", {
      name: "Deployment YAML",
    });
    fireEvent.change(editor, { target: { value: "invalid" } });
    const error = await screen.findByText("spec is required");
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
    expect(
      editor.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(editor).toHaveValue(original);
    expect(saved).toEqual([]);
    await waitFor(() =>
      expect(screen.queryByText("spec is required")).not.toBeInTheDocument(),
    );
  });

  it("disables edit and reset controls when deployment authority is absent", async () => {
    vi.mocked(useScopedCapabilities).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useScopedCapabilities>);
    renderEditor();
    const editor = await screen.findByRole("textbox", {
      name: "Deployment YAML",
    });
    await waitFor(() => expect(editor).toHaveValue(original));
    expect(editor).toHaveAttribute("readonly");
    expect(screen.getByText("Read only")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Reset to default" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save Changes" }),
    ).not.toBeInTheDocument();
    await userEvent.type(editor, "replacement");
    expect(editor).toHaveValue(original);
    expect(saved).toEqual([]);
    expect(resetCount).toBe(0);
  });
});
