import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProfile } from "@/lib/agent.query";
import {
  type AgentConfigSnapshot,
  useAgentVersion,
  useAgentVersions,
  useRestoreAgentVersion,
} from "@/lib/agent-version.query";
import { AgentVersionHistoryDialog } from "./agent-version-history-dialog";

vi.mock("@/lib/auth/auth.query");

vi.mock("@/lib/agent.query", () => ({
  useProfile: vi.fn(),
}));

vi.mock("@/lib/agent-version.query", () => ({
  useAgentVersions: vi.fn(),
  useAgentVersion: vi.fn(),
  useRestoreAgentVersion: vi.fn(),
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

import {
  useHasPermissions,
  useMissingPermissions,
} from "@/lib/auth/auth.query";

const snapshot = (
  overrides: Partial<AgentConfigSnapshot> = {},
): AgentConfigSnapshot => ({
  agentType: "agent",
  name: "Support bot",
  description: null,
  icon: null,
  systemPrompt: "be helpful",
  considerContextUntrusted: false,
  toolExposureMode: "full",
  accessAllTools: false,
  accessAllSubagents: false,
  passthroughHeaders: [],
  incomingEmailEnabled: false,
  incomingEmailSecurityMode: "disabled",
  incomingEmailAllowedDomain: null,
  builtInAgentConfig: null,
  model: null,
  llmApiKey: null,
  identityProviderId: null,
  environmentId: null,
  tools: [],
  excludedTools: [],
  excludedSubagents: [],
  suggestedPrompts: [],
  hooks: [],
  knowledgeBases: [],
  connectors: [],
  ...overrides,
});

const versionRow = (version: number, contentHash: string) => ({
  id: `version-${version}`,
  agentId: "agent-1",
  version,
  contentHash,
  createdAt: "2026-08-03T10:00:00.000Z",
});

const versionDetail = (version: number, contentHash: string) => ({
  id: `version-${version}`,
  agentId: "agent-1",
  version,
  snapshot: snapshot({ systemPrompt: `prompt v${version}` }),
  contentHash,
  createdAt: "2026-08-03T10:00:00.000Z",
});

const mutateAsync = vi.fn();

function mockAgent(overrides: Record<string, unknown> = {}) {
  vi.mocked(useProfile).mockReturnValue({
    data: {
      id: "agent-1",
      name: "Support bot",
      agentType: "agent",
      builtIn: false,
      latestVersion: 3,
      ...overrides,
    },
    isPending: false,
    refetch: vi.fn(),
    // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
  } as any);
}

/** Head is v3; v2 and v1 are the history behind it. */
function mockVersions(
  rows: ReturnType<typeof versionRow>[] = [
    versionRow(3, "hash-head"),
    versionRow(2, "hash-two"),
    versionRow(1, "hash-one"),
  ],
) {
  vi.mocked(useAgentVersions).mockReturnValue({
    data: { pages: [{ data: rows }] },
    isPending: false,
    isSuccess: true,
    isError: false,
    refetch: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
  } as any);
}

/**
 * Versions listed here have settled: a detail object is a hit, `null` is the
 * 404 a pruned version answers. Anything absent is still in flight.
 */
function mockVersionDetails(
  details: Record<number, ReturnType<typeof versionDetail> | null>,
) {
  vi.mocked(useAgentVersion).mockImplementation(((
    _id: string | null,
    version: number | null,
  ) => {
    const entry = version === null ? null : details[version];
    const settled = version !== null && version in details;
    return {
      data: entry ?? null,
      isPending: !settled,
      isSuccess: settled,
      isError: false,
      refetch: vi.fn(),
    };
  }) as never);
}

function renderDialog() {
  return render(
    <AgentVersionHistoryDialog
      agentId="agent-1"
      open
      onOpenChange={() => {}}
    />,
  );
}

describe("AgentVersionHistoryDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` leaves implementations in place, so the mutation is
    // re-stubbed here rather than inheriting whatever the last test set. Null
    // is the "nothing was written" resolution; success cases override it.
    mutateAsync.mockResolvedValue(null);
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
    } as any);
    vi.mocked(useMissingPermissions).mockReturnValue({});
    vi.mocked(useRestoreAgentVersion).mockReturnValue({
      mutateAsync,
      isPending: false,
      // biome-ignore lint/suspicious/noExplicitAny: partial mutation is enough
    } as any);
    mockAgent();
    mockVersions();
    mockVersionDetails({
      3: versionDetail(3, "hash-head"),
      2: versionDetail(2, "hash-two"),
    });
  });

  it("opens on the head version and marks it as current", () => {
    renderDialog();

    expect(
      screen.getByRole("heading", { name: "Version 3" }),
    ).toBeInTheDocument();
    const headRow = screen.getByRole("button", { name: /v3/ });
    expect(within(headRow).getByText("Current")).toBeInTheDocument();
  });

  it("cannot restore the version the agent is already on", () => {
    renderDialog();

    expect(
      screen.getByRole("button", { name: "Restore this version" }),
    ).toBeDisabled();
  });

  it("trusts the fresh timeline over a stale profile for where the head is", () => {
    // The profile cache lags a concurrent edit: it still says v2 while the
    // freshly-fetched timeline already lists v3. Believing the profile would
    // badge the wrong row and offer to "restore" the actual head.
    mockAgent({ latestVersion: 2 });
    renderDialog();

    const headRow = screen.getByRole("button", { name: /v3/ });
    expect(within(headRow).getByText("Current")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Restore this version" }),
    ).toBeDisabled();
  });

  it("passes the previewed head to the mutation so a concurrent edit is caught", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /v2/ }));
    await user.click(
      screen.getByRole("button", { name: "Restore this version" }),
    );
    await user.click(screen.getByRole("button", { name: "Restore version 2" }));

    expect(mutateAsync).toHaveBeenCalledWith({
      agentId: "agent-1",
      version: 2,
      baseVersion: 3,
    });
  });

  it("keeps the confirmation open when the restore does not go through", async () => {
    const user = userEvent.setup();
    // A handled failure resolves to null — a moved head, or the 400 refusing a
    // version that points at something deleted — and its toast needs the
    // dialog it refers to still on screen.
    mutateAsync.mockResolvedValue(null);
    renderDialog();

    await user.click(screen.getByRole("button", { name: /v2/ }));
    await user.click(
      screen.getByRole("button", { name: "Restore this version" }),
    );
    await user.click(screen.getByRole("button", { name: "Restore version 2" }));

    expect(
      screen.getByRole("button", { name: "Restore version 2" }),
    ).toBeInTheDocument();
  });

  it("jumps the selection to the version a restore just created", async () => {
    const user = userEvent.setup();
    // A restore lands as a new head the timeline does not list yet; the
    // preview must follow it rather than keep showing the source version.
    mutateAsync.mockResolvedValue({ id: "agent-1", latestVersion: 4 });
    mockVersionDetails({
      4: versionDetail(4, "hash-four"),
      3: versionDetail(3, "hash-head"),
      2: versionDetail(2, "hash-two"),
    });
    renderDialog();

    await user.click(screen.getByRole("button", { name: /v2/ }));
    await user.click(
      screen.getByRole("button", { name: "Restore this version" }),
    );
    await user.click(screen.getByRole("button", { name: "Restore version 2" }));

    expect(
      await screen.findByRole("heading", { name: "Version 4" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Restore version 2" }),
    ).not.toBeInTheDocument();
  });

  it("explains a pruned predecessor instead of claiming to load it", async () => {
    const user = userEvent.setup();
    // v1 has settled as null — the 404 retention answers for a pruned
    // version — so v2 has no baseline and never will. The disabled Changes
    // button must say that, not promise a load that cannot arrive.
    mockVersionDetails({
      3: versionDetail(3, "hash-head"),
      2: versionDetail(2, "hash-two"),
      1: null,
    });
    renderDialog();

    await user.click(screen.getByRole("button", { name: /v2/ }));

    const changesButton = screen.getByRole("button", { name: "Changes" });
    expect(changesButton).toBeDisabled();
    await user.hover(changesButton.parentElement as HTMLElement);
    // radix renders the content and a screen-reader copy of it
    expect(
      await screen.findAllByText(
        "Version 1 is no longer available, so there is nothing to compare against.",
      ),
    ).not.toHaveLength(0);
    expect(screen.queryByText("Loading version 1...")).not.toBeInTheDocument();
  });

  it("shows an empty preview for a config that never recorded a version", () => {
    // `latestVersion: 0` is the column default for an agent created before
    // versioning shipped, not a head. Reading it as one pointed the detail
    // query at version 0 — which the hook refuses to fetch — and left the
    // pane on "Loading version..." forever.
    mockAgent({ latestVersion: 0 });
    mockVersions([]);
    renderDialog();

    expect(screen.queryByText("Loading version...")).not.toBeInTheDocument();
    expect(screen.getByText(/Nothing to preview yet/)).toBeInTheDocument();
    expect(
      screen.getByText(/No versions yet\. The next configuration change/),
    ).toBeInTheDocument();
  });

  it("blocks restoring a built-in agent", async () => {
    const user = userEvent.setup();
    mockAgent({ builtIn: true });
    renderDialog();

    await user.click(screen.getByRole("button", { name: /v2/ }));

    expect(
      screen.getByRole("button", { name: "Restore this version" }),
    ).toBeDisabled();
  });
});
