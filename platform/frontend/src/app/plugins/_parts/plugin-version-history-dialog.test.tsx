import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  usePlugin,
  usePluginVersion,
  usePluginVersions,
  useRestorePluginVersion,
} from "@/lib/plugins/plugin.query";
import { PluginVersionHistoryDialog } from "./plugin-version-history-dialog";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");

vi.mock("@/lib/plugins/plugin.query", () => ({
  usePlugin: vi.fn(),
  usePluginVersions: vi.fn(),
  usePluginVersion: vi.fn(),
  useRestorePluginVersion: vi.fn(),
}));

// Monaco needs a real browser layout engine, so both editors stand in as plain
// nodes that still expose the text each side of the diff was given.
vi.mock("@/components/diff-editor", () => ({
  DiffEditor: ({
    original,
    modified,
  }: {
    original: string;
    modified: string;
  }) => (
    <div data-testid="diff">
      <span data-testid="diff-original">{original}</span>
      <span data-testid="diff-modified">{modified}</span>
    </div>
  ),
}));
vi.mock("@/components/editor", () => ({
  Editor: ({ value }: { value: string }) => (
    <div data-testid="editor">{value}</div>
  ),
}));

const file = (path: string, content: string) => ({
  id: `file-${path}`,
  versionId: "version-x",
  path,
  content,
  encoding: "utf8" as const,
  mode: "100644" as const,
  digest: `sha256:${content}`,
});

const version = (number: number, files: ReturnType<typeof file>[]) => ({
  id: `version-${number}`,
  pluginId: "plugin-1",
  version: number,
  contentHash: `hash-${number}`,
  sourceCommit: null,
  createdAt: "2026-08-03T10:00:00.000Z",
  files,
});

const VERSIONS = {
  1: version(1, [file("README.md", "one")]),
  2: version(2, [file("README.md", "two")]),
  3: version(3, [file("README.md", "two"), file("hooks/run.sh", "echo hi")]),
};

const restoreAsync = vi.fn();

function mockPlugin(overrides: Record<string, unknown> = {}) {
  vi.mocked(usePlugin).mockReturnValue({
    data: {
      id: "plugin-1",
      displayName: "Policy Runtime",
      contentHash: "hash-3",
      sourceKind: "manual",
      sourceProvider: null,
      files: VERSIONS[3].files,
      ...overrides,
    },
    isPending: false,
    refetch: vi.fn(),
    // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
  } as any);
}

const railRow = (number: number) =>
  screen.getByRole("button", { name: new RegExp(`^Version ${number}\\b`) });
const restoreButton = () =>
  screen.getByRole("button", { name: /^Restore v\d+$/ });
const hunk = (path: string) => screen.getByRole("region", { name: path });

const renderDialog = () =>
  render(
    <PluginVersionHistoryDialog
      pluginId="plugin-1"
      open
      onOpenChange={vi.fn()}
    />,
  );

describe("PluginVersionHistoryDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      isPending: false,
      // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
    } as any);
    mockPlugin();
    vi.mocked(usePluginVersions).mockReturnValue({
      data: {
        pages: [
          {
            data: [3, 2, 1].map((number) => {
              const { files: _files, ...row } =
                VERSIONS[number as keyof typeof VERSIONS];
              return row;
            }),
          },
        ],
      },
      isPending: false,
      isError: false,
      refetch: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
    } as any);
    vi.mocked(usePluginVersion).mockImplementation(((
      _id: string | null,
      number: number | null,
    ) => ({
      data:
        number === null
          ? null
          : (VERSIONS[number as keyof typeof VERSIONS] ?? null),
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    })) as never);
    vi.mocked(useRestorePluginVersion).mockReturnValue({
      mutateAsync: restoreAsync,
      isPending: false,
      // biome-ignore lint/suspicious/noExplicitAny: partial mutation is enough
    } as any);
  });

  it("opens on the newest version, and shows what it changed against the one before", () => {
    renderDialog();

    expect(screen.getByText("Policy Runtime")).toBeInTheDocument();
    expect(within(railRow(3)).getByText("HEAD")).toBeInTheDocument();
    // Version 3 added a script and left README.md as it was.
    expect(hunk("hooks/run.sh")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "README.md" })).toBeNull();
    // The current version is not one to go back to.
    expect(restoreButton()).toHaveAttribute("aria-disabled", "true");
  });

  it("reads an earlier version as a diff of its files", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(railRow(2));

    const readme = hunk("README.md");
    expect(within(readme).getByTestId("diff-original")).toHaveTextContent(
      "one",
    );
    expect(within(readme).getByTestId("diff-modified")).toHaveTextContent(
      "two",
    );
  });

  it("restores an earlier version after saying which files go, guarded by the plugin's current hash", async () => {
    const user = userEvent.setup();
    restoreAsync.mockResolvedValue({ id: "plugin-1" });
    renderDialog();

    await user.click(railRow(1));
    await user.click(restoreButton());

    const confirm = screen.getByRole("dialog", { name: "Restore version 1?" });
    // The title asks; the text says only what else changes.
    expect(confirm).toHaveTextContent(
      "Installed copies change the next time they are updated.",
    );
    expect(confirm).not.toHaveTextContent("become the plugin's files");
    // The script the plugin has now is not in version 1.
    expect(confirm).toHaveTextContent(
      "The 1 file the plugin has now that version 1 does not is removed.",
    );
    expect(restoreAsync).not.toHaveBeenCalled();

    await user.click(
      within(confirm).getByRole("button", { name: "Restore version 1" }),
    );
    expect(restoreAsync).toHaveBeenCalledExactlyOnceWith({
      pluginId: "plugin-1",
      version: 1,
      baseContentHash: "hash-3",
    });
  });

  it("shows a Git plugin's history but does not offer to restore from it", async () => {
    const user = userEvent.setup();
    mockPlugin({ sourceKind: "github", sourceProvider: "github" });
    renderDialog();

    await user.click(railRow(1));

    expect(restoreButton()).toHaveAttribute("aria-disabled", "true");
    // In the banner, and on the button for someone who only hears that.
    expect(screen.getAllByText(/files come from GitHub/)).toHaveLength(2);
  });
});
