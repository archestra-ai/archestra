import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { EditCatalogContent } from "./edit-catalog-dialog";

vi.mock("@/lib/auth/auth.query");

const mutate = vi.fn();
vi.mock("@/lib/mcp/internal-mcp-catalog.query", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/mcp/internal-mcp-catalog.query")
  >()),
  useUpdateInternalMcpCatalogItem: () => ({ mutate, isPending: false }),
  useApproveCatalogItemImage: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/mcp/mcp-server.query", () => ({
  useMcpServers: () => ({ data: [] }),
}));
vi.mock("./mcp-catalog-form.utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-catalog-form.utils")>()),
  // Everything the full form sends, configuration included.
  transformFormToApiData: () => ({
    name: "notes",
    description: "My notes",
    icon: null,
    labels: [],
    serverType: "local",
    multitenant: false,
    localConfig: { dockerImage: "ghcr.io/acme/notes:1", command: "node" },
    environmentId: null,
  }),
}));
vi.mock("./mcp-catalog-form", () => ({
  McpCatalogForm: ({
    onSubmit,
    detailsOnly,
  }: {
    onSubmit: (values: never, form: never) => void;
    detailsOnly?: boolean;
  }) => (
    <button
      type="button"
      data-details-only={String(!!detailsOnly)}
      onClick={() => onSubmit({} as never, { setError: vi.fn() } as never)}
    >
      Save
    </button>
  ),
}));

const item = {
  id: "cat-1",
  name: "notes",
  serverType: "local",
  effectiveActions: ["read", "use", "update", "delete", "manage-permissions"],
} as never;

function viewAs(role: "member" | "editor") {
  vi.mocked(useHasPermissions).mockImplementation(
    (permissions) =>
      ({
        // Editors may add servers to the registry; members may not.
        data:
          role === "editor" &&
          (permissions.mcpRegistry?.includes("create") ?? false),
        isLoading: false,
      }) as ReturnType<typeof useHasPermissions>,
  );
}

describe("EditCatalogContent", () => {
  beforeEach(() => mutate.mockClear());

  it("lets a member who owns a server edit only its details", async () => {
    viewAs("member");
    render(<EditCatalogContent item={item} onClose={vi.fn()} />);

    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toHaveAttribute("data-details-only", "true");
    await userEvent.click(save);
    expect(mutate).toHaveBeenCalledWith(
      {
        id: "cat-1",
        data: {
          name: "notes",
          description: "My notes",
          icon: null,
          labels: [],
        },
      },
      expect.anything(),
    );
  });

  it("sends the configuration for someone who may add servers", async () => {
    viewAs("editor");
    render(<EditCatalogContent item={item} onClose={vi.fn()} />);

    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toHaveAttribute("data-details-only", "false");
    await userEvent.click(save);
    expect(mutate).toHaveBeenCalledWith(
      {
        id: "cat-1",
        data: expect.objectContaining({
          localConfig: { dockerImage: "ghcr.io/acme/notes:1", command: "node" },
        }),
      },
      expect.anything(),
    );
  });
});
