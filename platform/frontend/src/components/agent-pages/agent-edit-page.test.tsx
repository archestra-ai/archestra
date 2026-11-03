import { archestraApiClient, E2eTestId } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProfile } from "@/lib/agent.query";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { AgentEditPage } from "./agent-edit-page";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/agent.query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent.query")>()),
  useProfile: vi.fn(),
}));

// The form has its own tests. Here it reports what the page mounted and
// showed, and hands back a dirty marker so saving and the guard can be driven.
let realPermissions = false;
const formMounts = vi.fn();
vi.mock("@/components/agent-form", async () => {
  const { useEffect } = await import("react");
  return {
    AgentForm: (props: {
      sections: string[];
      activeSection: string[];
      readOnly?: boolean;
      onDirtyChange?: (dirty: boolean) => void;
      footer: (state: {
        formId: string;
        isCreate: boolean;
        isSaving: boolean;
        isDirty: boolean;
        canSubmit: boolean;
        readOnly: boolean;
        hasRuntime: boolean;
      }) => React.ReactNode;
    }) => {
      useEffect(() => {
        formMounts();
      }, []);
      return (
        <div>
          <span>{`mounted: ${props.sections.join(",")}`}</span>
          <span>{`showing: ${props.activeSection.join(",")}`}</span>
          <button type="button" onClick={() => props.onDirtyChange?.(true)}>
            make dirty
          </button>
          {props.footer({
            formId: "form",
            isCreate: false,
            isSaving: false,
            isDirty: !props.readOnly,
            canSubmit: true,
            readOnly: !!props.readOnly,
            hasRuntime: false,
          })}
        </div>
      );
    },
  };
});
vi.mock("@/components/resource-permissions", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/resource-permissions")>();
  return {
    ...actual,
    ResourcePermissions: (
      props: React.ComponentProps<typeof actual.ResourcePermissions>,
    ) =>
      realPermissions ? (
        <actual.ResourcePermissions {...props} />
      ) : (
        <div data-testid="resource-permissions" />
      ),
  };
});

let access = {
  resource: "agent",
  canModify: true,
  canEdit: true,
  canCreate: true,
  canDelete: true,
  isBuiltIn: false,
  currentUserId: "me",
  isPending: false,
};
vi.mock("./use-agent-access", () => ({ useAgentAccess: () => access }));

const agent = {
  id: "a1",
  name: "Support Agent",
  agentType: "agent",
  builtIn: false,
  scope: "personal",
  icon: null,
  description: null,
  teams: [],
  environmentId: null,
};

describe("AgentEditPage", () => {
  const replace = vi.fn();
  const push = vi.fn();

  function atStep(step?: string) {
    const search = step ? `step=${step}` : "";
    window.history.replaceState(
      {},
      "",
      `/agents/a1/edit${search ? `?${search}` : ""}`,
    );
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams(search) as unknown as ReturnType<
        typeof useSearchParams
      >,
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    realPermissions = false;
    access = { ...access, canEdit: true, isBuiltIn: false };
    vi.mocked(useAppName).mockReturnValue("Archestra");
    vi.mocked(useFeature).mockReturnValue(true);
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      isPending: false,
    } as unknown as ReturnType<typeof useHasPermissions>);
    vi.mocked(useRouter).mockReturnValue({
      push,
      replace,
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(usePathname).mockReturnValue("/agents/a1/edit");
    vi.mocked(useProfile).mockReturnValue({
      data: agent,
      isPending: false,
    } as unknown as ReturnType<typeof useProfile>);
    atStep();
  });

  it("keeps every step on one form, showing the runtime with Configuration", () => {
    render(<AgentEditPage id="a1" />);

    expect(
      screen.getByText(
        "mounted: configuration,runtime,tools,messaging,advanced",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("showing: configuration,runtime"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("resource-permissions")).toBeVisible();
  });

  it("jumps to any step from the header, on the same mount", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<AgentEditPage id="a1" />);

    await user.click(
      screen.getByRole("button", { name: /Step 4 of 4: Advanced/ }),
    );
    expect(replace).toHaveBeenCalledWith("/agents/a1/edit?step=advanced", {
      scroll: false,
    });

    atStep("advanced");
    rerender(<AgentEditPage id="a1" />);
    expect(screen.getByText("showing: advanced")).toBeInTheDocument();
    // Who can use it belongs to Configuration, but stays mounted so its
    // edits survive the visit.
    expect(
      screen.getByTestId("resource-permissions").parentElement,
    ).toHaveClass("hidden");
    expect(formMounts).toHaveBeenCalledOnce();
  });

  it("saves from the first step without visiting the others", async () => {
    const user = userEvent.setup();
    render(<AgentEditPage id="a1" />);

    const save = screen.getByRole("button", { name: "Save changes" });
    expect(save).toBeEnabled();
    // Or move on with Next, to the step after this one.
    await user.click(screen.getByTestId(E2eTestId.AgentSetupNextButton));
    expect(replace).toHaveBeenCalledWith("/agents/a1/edit?step=tools", {
      scroll: false,
    });
  });

  it("asks before Cancel throws away unsaved changes", async () => {
    const user = userEvent.setup();
    render(<AgentEditPage id="a1" />);

    await user.click(screen.getByRole("button", { name: "make dirty" }));
    expect(screen.getByText(/Unsaved changes/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByText(/discard unsaved changes\?/i)).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("saves real permission edits when the agent configuration is read-only", async () => {
    Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
    realPermissions = true;
    access = { ...access, canEdit: false };
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "me" } },
    } as ReturnType<typeof useSession>);
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
      isPending: false,
    } as ReturnType<typeof useHasPermissions>);
    const origin = "http://localhost:9000";
    archestraApiClient.setConfig({ baseUrl: origin });
    let grants = [
      {
        subject: { type: "user", id: "me" },
        name: "Creator",
        actions: ["read", "use", "update", "delete", "manage-permissions"],
      },
      {
        subject: { type: "team", id: "other-team" },
        name: "Partner Team",
        actions: ["read"],
      },
    ];
    let saved = false;
    const policy = () => ({
      resource: "agent",
      scope: "a1",
      name: "Support Agent",
      ownerId: "me",
      revision: 1,
      grants,
      inheritedGrants: [],
      effectiveActions: [
        "read",
        "use",
        "update",
        "delete",
        "manage-permissions",
      ],
      canShareOrganizationWide: false,
      actorSubjects: [{ type: "user", id: "me" }],
    });
    const server = setupServer(
      http.get(`${origin}/api/resource-permissions/agent/a1`, () =>
        HttpResponse.json(policy()),
      ),
      http.get(`${origin}/api/resource-permissions`, () =>
        HttpResponse.json([]),
      ),
      http.put(
        `${origin}/api/resource-permissions/agent/a1`,
        async ({ request }) => {
          const body = (await request.json()) as { grants: typeof grants };
          expect(body.grants).toContainEqual({
            subject: { type: "team", id: "other-team" },
            actions: ["read", "use"],
          });
          saved = true;
          grants = body.grants.map((grant) => ({
            ...grant,
            name: grant.subject.type === "team" ? "Partner Team" : "Creator",
          }));
          return HttpResponse.json({ ...policy(), revision: 2 });
        },
      ),
    );
    server.listen({ onUnhandledRequest: "error" });
    try {
      const user = userEvent.setup();
      render(
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          <AgentEditPage id="a1" />
        </QueryClientProvider>,
      );
      await user.click(
        await screen.findByRole("combobox", {
          name: "Permission for Partner Team",
        }),
      );
      await user.click(await screen.findByRole("option", { name: "Can use" }));
      await user.click(
        await screen.findByRole("button", {
          name: "Save changes",
        }),
      );
      await waitFor(() => expect(saved).toBe(true));
      expect(
        screen.getByText(/you can view this agent's configuration/i),
      ).toBeVisible();
    } finally {
      server.close();
      archestraApiClient.setConfig({ baseUrl: "" });
    }
  });

  it("offers a reader who cannot change it the settings without a save", () => {
    access = { ...access, canEdit: false };
    render(<AgentEditPage id="a1" />);

    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(screen.getByRole("button", { name: "Close" })).toBeVisible();
    expect(
      screen.getByText(/you can view this agent's configuration/i),
    ).toBeVisible();
  });
});
