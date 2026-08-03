import type { archestraApiTypes } from "@archestra/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/hooks/use-app-name", () => ({
  useAppName: () => "Archestra",
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// Only the two hooks are stubbed. The conflict code and the reader that pulls
// it off an error stay real, so these tests break if the wire code the backend
// sends and the one the editor recognises ever drift apart.
vi.mock("@/lib/mcp/internal-mcp-catalog.query", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/mcp/internal-mcp-catalog.query")
  >()),
  useGetDeploymentYamlPreview: vi.fn(),
  useUpdateInternalMcpCatalogItem: vi.fn(),
}));

// Stand in for the Monaco-backed editor: a textarea for edits, a button
// standing in for its "Reset to default" control, and a second one standing in
// for that reset coming back as a 409. The token it would send with the reset
// is rendered, since that is the whole contract between the two components.
vi.mock("./k8s-yaml-editor", () => ({
  K8sYamlEditor: ({
    value,
    onChange,
    onReset,
    expectedRevision,
    onResetConflict,
  }: {
    value: string | undefined;
    onChange: (value: string) => void;
    onReset: (result: { yaml: string; revision: number }) => void;
    expectedRevision?: number | null;
    onResetConflict?: () => void;
  }) => (
    <>
      <textarea
        aria-label="deployment yaml"
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
      />
      <output aria-label="reset token">{String(expectedRevision)}</output>
      <button
        type="button"
        onClick={() => onReset({ yaml: "reset: true", revision: 9 })}
      >
        reset to default
      </button>
      <button type="button" onClick={() => onResetConflict?.()}>
        reset lost the race
      </button>
    </>
  ),
}));

import { toast } from "sonner";
import {
  CATALOG_STALE_WRITE_CODE,
  useGetDeploymentYamlPreview,
  useUpdateInternalMcpCatalogItem,
} from "@/lib/mcp/internal-mcp-catalog.query";
import { YamlConfigContent } from "./yaml-config-dialog";

type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

const mutateAsync = vi.fn();

// Stands in for TanStack's mutation error state, which the component reads to
// decide whether the last save lost a race.
let mutationError: Error | null = null;
const resetMutation = vi.fn(() => {
  mutationError = null;
  applyMutationMock();
});

function applyMutationMock() {
  vi.mocked(useUpdateInternalMcpCatalogItem).mockReturnValue({
    mutateAsync,
    isPending: false,
    error: mutationError,
    reset: resetMutation,
  } as unknown as ReturnType<typeof useUpdateInternalMcpCatalogItem>);
}

function staleWriteError() {
  const error = new Error(
    "Catalog item is at revision 7, not 4; re-read and retry.",
  ) as Error & { internalCode?: string };
  error.internalCode = CATALOG_STALE_WRITE_CODE;
  return error;
}

function catalogItem(revision: number): CatalogItem {
  return {
    id: "catalog-1",
    serverType: "local",
    revision,
  } as unknown as CatalogItem;
}

// What the preview query would answer right now — both as the rendered `data`
// and as what an explicit refetch resolves to. A failing refetch still RESOLVES
// in TanStack v5, carrying the last successful `data`, so `refetchFails` leaves
// `currentPreview` in place and only flips the status.
let currentPreview: { yaml: string; revision: number };
let refetchFails = false;
const refetchPreview = vi.fn(async () => ({
  data: currentPreview,
  isError: refetchFails,
}));

function setPreview(preview: { yaml: string; revision: number }) {
  currentPreview = preview;
  vi.mocked(useGetDeploymentYamlPreview).mockReturnValue({
    data: preview,
    isLoading: false,
    refetch: refetchPreview,
  } as unknown as ReturnType<typeof useGetDeploymentYamlPreview>);
}

function renderEditor(item: CatalogItem) {
  return render(<YamlConfigContent item={item} onClose={vi.fn()} hideHeader />);
}

function editor() {
  return screen.getByLabelText("deployment yaml");
}

async function save() {
  const before = mutateAsync.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
  await waitFor(() =>
    expect(mutateAsync.mock.calls.length).toBeGreaterThan(before),
  );
  return mutateAsync.mock.calls.at(-1)?.[0];
}

/**
 * A deployment document is the widest single-field overwrite in the registry,
 * so the editor sends the `revision` it was filled from and the save is refused
 * if the item moved on. That only holds while the token keeps describing the
 * document actually on screen — these pin the two together.
 */
describe("YamlConfigContent — optimistic concurrency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutationError = null;
    refetchFails = false;
    mutateAsync.mockResolvedValue({ revision: 5 });
    applyMutationMock();
  });

  it("arms the token from the response that produced the document", async () => {
    // The document comes from the preview query and the item from the catalog
    // list query — two independent fetches. Taking the token from the item
    // would certify a snapshot the editor never showed.
    setPreview({ yaml: "spec: original", revision: 4 });
    renderEditor(catalogItem(11));

    fireEvent.change(editor(), { target: { value: "spec: mine" } });

    expect(await save()).toMatchObject({
      data: expect.objectContaining({ expectedRevision: 4 }),
    });
  });

  it("a background refetch neither replaces in-progress edits nor re-arms the token", async () => {
    setPreview({ yaml: "spec: original", revision: 4 });
    const { rerender } = renderEditor(catalogItem(4));

    fireEvent.change(editor(), { target: { value: "spec: mine" } });

    // Another admin saves while this editor is open; TanStack refetches on
    // window focus and re-delivers both queries.
    setPreview({ yaml: "spec: theirs", revision: 7 });
    rerender(
      <YamlConfigContent item={catalogItem(7)} onClose={vi.fn()} hideHeader />,
    );

    expect(editor()).toHaveValue("spec: mine");
    // Still 4: the save must conflict against their edit rather than silently
    // overwrite it with a document this user never saw.
    expect(await save()).toMatchObject({
      data: expect.objectContaining({ expectedRevision: 4 }),
    });
  });

  it("a clean editor adopts a background refetch", async () => {
    // The counterpart to the case above: with nothing to protect, the tab has
    // to track the server rather than sit on the manifest it opened with. The
    // registry detail page keeps this editor mounted for as long as the YAML
    // tab is selected, so "stale until remount" can mean stale for hours.
    setPreview({ yaml: "spec: original", revision: 4 });
    const { rerender } = renderEditor(catalogItem(4));

    expect(editor()).toHaveValue("spec: original");

    setPreview({ yaml: "spec: theirs", revision: 7 });
    rerender(
      <YamlConfigContent item={catalogItem(7)} onClose={vi.fn()} hideHeader />,
    );

    expect(editor()).toHaveValue("spec: theirs");

    // The token moved with the document, so an edit from here saves against
    // their revision instead of conflicting against a snapshot nobody is on.
    fireEvent.change(editor(), { target: { value: "spec: mine" } });
    expect(await save()).toMatchObject({
      data: expect.objectContaining({ expectedRevision: 7 }),
    });
  });

  it("a stale-write conflict offers a reload that re-arms the token", async () => {
    setPreview({ yaml: "spec: original", revision: 4 });
    const { rerender } = renderEditor(catalogItem(4));

    fireEvent.change(editor(), { target: { value: "spec: mine" } });
    mutateAsync.mockRejectedValueOnce(staleWriteError());
    expect(await save()).toMatchObject({
      data: expect.objectContaining({ expectedRevision: 4 }),
    });

    // The mutation now holds the conflict, and its handler has invalidated the
    // preview, so the winning document is a refetch away.
    mutationError = staleWriteError();
    applyMutationMock();
    setPreview({ yaml: "spec: theirs", revision: 7 });
    rerender(
      <YamlConfigContent item={catalogItem(7)} onClose={vi.fn()} hideHeader />,
    );

    // Their text survives the failure — but retrying would send the same spent
    // token forever, and on the registry detail page nothing unmounts this
    // editor to break the loop. Recovery has to be offered here.
    expect(editor()).toHaveValue("spec: mine");
    fireEvent.click(
      screen.getByRole("button", { name: /discard mine & reload/i }),
    );

    await waitFor(() => expect(editor()).toHaveValue("spec: theirs"));
    expect(
      screen.queryByRole("button", { name: /discard mine & reload/i }),
    ).not.toBeInTheDocument();

    // Re-armed from the same response that produced the document on screen, so
    // the next save lands instead of conflicting again.
    fireEvent.change(editor(), { target: { value: "spec: theirs + mine" } });
    expect(await save()).toMatchObject({
      data: expect.objectContaining({ expectedRevision: 7 }),
    });
  });

  it("a failed reload keeps the user's text and the conflict", async () => {
    // The reload is the only thing standing between a conflict and the user's
    // unsaved document, and nothing else holds that text. A failed refetch
    // still resolves with the last successful `data`, so treating "we have
    // data" as "the reload worked" would re-baseline onto the pre-conflict
    // snapshot: their text gone, the banner cleared, and the next save
    // conflicting again with nothing on screen to explain why.
    setPreview({ yaml: "spec: original", revision: 4 });
    const { rerender } = renderEditor(catalogItem(4));

    fireEvent.change(editor(), { target: { value: "spec: mine" } });
    mutateAsync.mockRejectedValueOnce(staleWriteError());
    await save();

    mutationError = staleWriteError();
    applyMutationMock();
    rerender(
      <YamlConfigContent item={catalogItem(7)} onClose={vi.fn()} hideHeader />,
    );

    // The server is at 7, but the refetch that would have fetched it fails, so
    // the cache still holds the revision-4 snapshot this editor started from.
    refetchFails = true;
    fireEvent.click(
      screen.getByRole("button", { name: /discard mine & reload/i }),
    );

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(editor()).toHaveValue("spec: mine");
    expect(
      screen.getByRole("button", { name: /discard mine & reload/i }),
    ).toBeInTheDocument();

    // Still armed with the spent token rather than silently re-armed on a
    // snapshot the reload never actually reached.
    expect(await save()).toMatchObject({
      data: expect.objectContaining({ expectedRevision: 4 }),
    });
  });

  it("a reset carries the token and its conflict is recoverable", async () => {
    // Reset clears the whole stored manifest and rolls every pod onto the
    // generated default — the widest write in the dialog, sitting one button
    // away from the guarded save. It sends the same token, and a refusal has
    // to reach the same banner: a toast would leave the user with no way to
    // see the winning document.
    setPreview({ yaml: "spec: original", revision: 4 });
    renderEditor(catalogItem(4));

    expect(screen.getByLabelText("reset token")).toHaveTextContent("4");
    expect(
      screen.queryByRole("button", { name: /discard mine & reload/i }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /reset lost the race/i }),
    );

    expect(
      screen.getByRole("button", { name: /discard mine & reload/i }),
    ).toBeInTheDocument();

    setPreview({ yaml: "spec: theirs", revision: 7 });
    fireEvent.click(
      screen.getByRole("button", { name: /discard mine & reload/i }),
    );

    await waitFor(() => expect(editor()).toHaveValue("spec: theirs"));
    expect(
      screen.queryByRole("button", { name: /discard mine & reload/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("reset token")).toHaveTextContent("7");
  });

  it("a reset re-baselines the document and its token", async () => {
    setPreview({ yaml: "spec: original", revision: 4 });
    renderEditor(catalogItem(4));

    // The reset writes immediately, so it leaves the editor clean and carries
    // its own post-write token.
    fireEvent.click(screen.getByRole("button", { name: /reset to default/i }));
    expect(editor()).toHaveValue("reset: true");
    expect(
      screen.queryByRole("button", { name: /save changes/i }),
    ).not.toBeInTheDocument();

    fireEvent.change(editor(), { target: { value: "reset: true\nmore: yes" } });
    expect(await save()).toMatchObject({
      data: expect.objectContaining({ expectedRevision: 9 }),
    });
  });

  it("a save re-baselines the document and re-arms the token", async () => {
    // The registry detail page keeps this editor mounted after a save, and the
    // hydration guard above stops the preview refetch from re-arming. Without
    // taking the token from the write itself, a second save would carry a
    // spent one and conflict with this user's own edit.
    setPreview({ yaml: "spec: original", revision: 4 });
    mutateAsync.mockResolvedValue({ revision: 5 });
    renderEditor(catalogItem(4));

    fireEvent.change(editor(), { target: { value: "spec: mine" } });
    expect(await save()).toMatchObject({
      data: expect.objectContaining({ expectedRevision: 4 }),
    });

    // The saved document is the new baseline, so Save goes away until the
    // next edit.
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /save changes/i }),
      ).not.toBeInTheDocument(),
    );

    fireEvent.change(editor(), { target: { value: "spec: mine again" } });
    expect(await save()).toMatchObject({
      data: expect.objectContaining({ expectedRevision: 5 }),
    });
  });
});
