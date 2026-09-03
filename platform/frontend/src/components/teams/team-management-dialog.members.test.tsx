import type { archestraApiTypes } from "@archestra/shared";
import { archestraApiSdk } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useMemberSearch } from "@/lib/member.query";
import { useActiveOrganization } from "@/lib/organization.query";
import { TeamManagementDialog } from "./team-management-dialog";

type Team = archestraApiTypes.GetTeamsResponses["200"]["data"][number];

const { useTokensMock } = vi.hoisted(() => ({ useTokensMock: vi.fn() }));

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/member.query");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/config/config", () => ({
  default: { enterpriseFeatures: { core: false } },
}));
vi.mock("@/lib/teams/team-token.query", () => ({ useTokens: useTokensMock }));
vi.mock("@archestra/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@archestra/shared")>()),
  archestraApiSdk: {
    getTeamMembers: vi.fn(),
    updateTeamMember: vi.fn(),
    updateTeam: vi.fn(),
  },
}));

const team = {
  id: "team-1",
  name: "Platform Engineering",
  description: "",
  labels: [],
} as unknown as Team;

// The role trigger's accessible name does not include its rendered value
// (Radix SelectValue), so locate it by its visible content instead.
async function findRoleTrigger(label: RegExp) {
  return await waitFor(() => {
    const trigger = screen
      .getAllByRole("combobox")
      .find((el) => label.test(el.textContent ?? ""));
    if (!trigger) throw new Error(`No combobox showing ${label}`);
    return trigger;
  });
}

async function setupUserEvent() {
  // Radix Select relies on pointer-capture + scrollIntoView, which jsdom
  // does not implement.
  window.HTMLElement.prototype.hasPointerCapture = vi.fn();
  window.HTMLElement.prototype.setPointerCapture = vi.fn();
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  const { default: userEvent } = await import("@testing-library/user-event");
  return userEvent.setup();
}

function renderDialog() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TeamManagementDialog open onOpenChange={vi.fn()} team={team} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useFeature).mockReturnValue(false as ReturnType<typeof useFeature>);
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
  vi.mocked(useActiveOrganization).mockReturnValue({
    data: { members: [{ userId: "u-1", user: { name: "Rosa Lindqvist" } }] },
    // biome-ignore lint/suspicious/noExplicitAny: partial query result stub
  } as any);
  vi.mocked(useMemberSearch).mockReturnValue({
    users: [],
    isSearching: false,
    onSearchQueryChange: vi.fn(),
    emptyMessage: "",
    // biome-ignore lint/suspicious/noExplicitAny: partial hook result stub
  } as any);
  useTokensMock.mockReturnValue({ data: { tokens: [] } });
  vi.mocked(archestraApiSdk.getTeamMembers).mockResolvedValue({
    data: [{ userId: "u-1", role: "member", name: "Rosa Lindqvist" }],
    // biome-ignore lint/suspicious/noExplicitAny: partial sdk result stub
  } as any);
  vi.mocked(archestraApiSdk.updateTeam).mockResolvedValue({
    data: team,
    // biome-ignore lint/suspicious/noExplicitAny: partial sdk result stub
  } as any);
  vi.mocked(archestraApiSdk.updateTeamMember).mockResolvedValue({
    data: {},
    // biome-ignore lint/suspicious/noExplicitAny: partial sdk result stub
  } as any);
});

describe("TeamManagementDialog member roles", () => {
  it("labels the role control by what it grants, never as an RBAC role name", async () => {
    const user = await setupUserEvent();
    renderDialog();

    const trigger = await findRoleTrigger(/not able to edit team/i);
    await user.click(trigger);

    const listbox = await screen.findByRole("listbox");
    expect(
      within(listbox).getByRole("option", { name: "Able to edit team" }),
    ).toBeInTheDocument();
    expect(
      within(listbox).getByRole("option", { name: "Not able to edit team" }),
    ).toBeInTheDocument();

    // The two stored values share their names with organization-wide RBAC
    // roles. Surfacing those names here is the confusion this wording exists
    // to prevent, so no option may be labelled with one.
    for (const option of within(listbox).getAllByRole("option")) {
      expect(option).not.toHaveAccessibleName("Admin");
      expect(option).not.toHaveAccessibleName("Member");
    }
  });

  it("still sends the stored role value when the new label is chosen", async () => {
    const user = await setupUserEvent();
    renderDialog();

    await user.click(await findRoleTrigger(/not able to edit team/i));
    await user.click(
      await screen.findByRole("option", { name: "Able to edit team" }),
    );
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(archestraApiSdk.updateTeamMember).toHaveBeenCalledWith({
        path: { id: "team-1", userId: "u-1" },
        body: { role: "admin" },
      });
    });
  });

  it("explains what syncs and what does not, and jumps to External Group Sync", async () => {
    const user = await setupUserEvent();
    renderDialog();

    const note = (
      await screen.findByText(/only for adding members by hand/i)
    ).closest("p");
    // The docs link appends screen-reader-only text, so match around it.
    expect(note).toHaveTextContent(
      /External Group Sync syncs membership and Role Mapping/,
    );
    expect(note).toHaveTextContent(
      /in your OIDC provider syncs roles — never this setting\./,
    );

    await user.click(
      within(note as HTMLElement).getByRole("button", {
        name: "External Group Sync",
      }),
    );
    // The section behind the jump is enterprise-gated in this harness, so the
    // license fallback standing in for it proves the navigation happened.
    expect(
      await screen.findByText(/Team Sync is an enterprise feature/i),
    ).toBeInTheDocument();
  });
});
