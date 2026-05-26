import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ShareFlow } from "./share-flow";

const { createMutateAsyncMock, revokeMutateAsyncMock } = vi.hoisted(() => ({
  createMutateAsyncMock: vi.fn(),
  revokeMutateAsyncMock: vi.fn(),
}));

vi.mock("@/lib/skills/skill-share.query", () => ({
  useCreateSkillShareLink: () => ({
    mutateAsync: createMutateAsyncMock,
    isPending: false,
  }),
  useRevokeSkillShareLink: () => ({
    mutateAsync: revokeMutateAsyncMock,
    isPending: false,
  }),
}));

vi.mock("@/lib/hooks/use-app-name", () => ({
  useAppName: () => "Archestra",
}));

const skill = { id: "skill-1", name: "warehouse-postgres" };

const fakeCreateResponse = {
  link: {
    id: "link-1",
    organizationId: "org-1",
    createdByUserId: "user-1",
    tokenStart: "archestra_skl_",
    name: null,
    marketplaceName: "org-12345678-skills",
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "active" as const,
    skills: [{ id: skill.id, name: skill.name, description: "" }],
  },
  rawToken: "archestra_skl_rawtoken",
  cloneUrl:
    "https://archestra.example/skills/m/archestra_skl_rawtoken/repo.git",
  marketplaceName: "org-12345678-skills",
};

describe("ShareFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("walks through pick → configure → install for Claude Code", async () => {
    createMutateAsyncMock.mockResolvedValue(fakeCreateResponse);

    render(<ShareFlow open skill={skill} onOpenChange={vi.fn()} />);

    // Step 1: Claude Code is pre-selected; press Continue.
    expect(screen.getByTestId("share-client-claude-code")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    // Step 2: choose 90 days then create.
    await userEvent.click(screen.getByTestId("share-ttl-90d"));
    await userEvent.click(
      screen.getByRole("button", { name: "Create share link" }),
    );

    await waitFor(() => expect(createMutateAsyncMock).toHaveBeenCalledTimes(1));
    const args = createMutateAsyncMock.mock.calls[0][0];
    expect(args.skillIds).toEqual([skill.id]);
    expect(args.expiresAt).toMatch(/^\d{4}-/);

    // Step 3: install snippet uses the cloneUrl and marketplace name.
    await waitFor(() =>
      expect(
        screen.getByTestId("share-snippets-claude-code"),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByText(
        `claude plugin marketplace add ${fakeCreateResponse.cloneUrl}`,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        `/plugin install warehouse-postgres@${fakeCreateResponse.marketplaceName}`,
      ),
    ).toBeInTheDocument();
  });

  it("renders both Claude and Codex snippets when both is chosen", async () => {
    createMutateAsyncMock.mockResolvedValue(fakeCreateResponse);

    render(<ShareFlow open skill={skill} onOpenChange={vi.fn()} />);

    await userEvent.click(screen.getByTestId("share-client-both"));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Create share link" }),
    );

    await waitFor(() =>
      expect(
        screen.getByTestId("share-snippets-claude-code"),
      ).toBeInTheDocument(),
    );
    expect(screen.getByTestId("share-snippets-codex")).toBeInTheDocument();
    expect(
      screen.getByText(
        `codex plugin marketplace add ${fakeCreateResponse.cloneUrl}`,
      ),
    ).toBeInTheDocument();
  });

  it("revokes the link from step 3 after confirmation", async () => {
    createMutateAsyncMock.mockResolvedValue(fakeCreateResponse);
    revokeMutateAsyncMock.mockResolvedValue({ success: true });
    const onOpenChange = vi.fn();

    render(<ShareFlow open skill={skill} onOpenChange={onOpenChange} />);

    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Create share link" }),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("share-snippets-claude-code"),
      ).toBeInTheDocument(),
    );

    await userEvent.click(
      screen.getByRole("button", { name: /Revoke share link/i }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Confirm revoke/i }),
    );

    await waitFor(() =>
      expect(revokeMutateAsyncMock).toHaveBeenCalledWith(
        fakeCreateResponse.link.id,
      ),
    );
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });
});
