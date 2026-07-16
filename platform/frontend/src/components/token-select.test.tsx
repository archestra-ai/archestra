import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DYNAMIC_CREDENTIAL_VALUE,
  TokenSelect,
} from "@/components/token-select";

const { useMcpServersGroupedByCatalogMock, selectState, confirmDialogSpy } =
  vi.hoisted(() => ({
    useMcpServersGroupedByCatalogMock: vi.fn(),
    // Captures the mocked Select's onValueChange so a SelectItem "click" can
    // drive it (the real Radix Select can't be exercised in jsdom).
    selectState: {
      onValueChange: undefined as ((v: string) => void) | undefined,
    },
    confirmDialogSpy: vi.fn(),
  }));

vi.mock("@/lib/mcp/mcp-server.query", () => ({
  useMcpServersGroupedByCatalog: useMcpServersGroupedByCatalogMock,
}));

// TokenSelect reads the current user to label the selector's own connection in
// the personal-pin confirmation.
vi.mock("@/lib/auth/auth.query", () => ({
  useSession: () => ({ data: { user: { id: "current-user" } } }),
}));

// Stub the confirm dialog: record its props and, when open, expose confirm /
// cancel buttons so the selection gate can be driven without the real dialog.
vi.mock("@/components/static-credential-confirm-dialog", () => ({
  StaticCredentialConfirmDialog: (props: {
    open: boolean;
    pins: Array<{
      mcpName: string;
      ownerEmail: string;
      isCurrentUser: boolean;
    }>;
    onConfirm: () => void;
    onCancel: () => void;
  }) => {
    confirmDialogSpy(props);
    return props.open ? (
      <div data-testid="confirm-dialog">
        <button type="button" onClick={props.onConfirm}>
          confirm-pin
        </button>
        <button type="button" onClick={props.onCancel}>
          cancel-pin
        </button>
      </div>
    ) : null;
  },
}));

vi.mock("@/lib/utils", () => ({
  cn: (...classes: Array<string | false | null | undefined>) =>
    classes.filter(Boolean).join(" "),
}));

vi.mock("@/components/loading", () => ({
  LoadingSpinner: () => <div>Loading...</div>,
}));

vi.mock("@/components/divider", () => ({
  default: () => <div data-testid="divider" />,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    onValueChange,
  }: {
    children?: React.ReactNode;
    onValueChange?: (v: string) => void;
  }) => {
    selectState.onValueChange = onValueChange;
    return <div>{children}</div>;
  },
  SelectTrigger: ({ children }: { children?: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
  SelectValue: ({ placeholder }: { placeholder?: string }) => (
    <span>{placeholder}</span>
  ),
  SelectContent: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({
    children,
    value,
    description,
  }: {
    children?: React.ReactNode;
    value?: string;
    description?: React.ReactNode;
  }) => (
    <button
      type="button"
      onClick={() => value != null && selectState.onValueChange?.(value)}
    >
      <div>{children}</div>
      {description ? <div>{description}</div> : null}
    </button>
  ),
}));

const personalCred = {
  id: "user-cred",
  ownerEmail: "member@example.com",
  ownerId: "other-user",
  scope: "personal",
  catalogName: "Everything",
  name: "Everything",
  teamDetails: null,
};
const ownPersonalCred = {
  id: "own-cred",
  ownerEmail: "me@example.com",
  ownerId: "current-user",
  scope: "personal",
  catalogName: "Everything",
  name: "Everything",
  teamDetails: null,
};
const orgCred = {
  id: "org-cred",
  ownerEmail: "admin@example.com",
  ownerId: "admin-user",
  scope: "org",
  catalogName: "Everything",
  name: "Everything",
  teamDetails: null,
};

const lastPins = () =>
  confirmDialogSpy.mock.calls.at(-1)?.[0]?.pins as
    | Array<{ mcpName: string; ownerEmail: string; isCurrentUser: boolean }>
    | undefined;

describe("TokenSelect", () => {
  beforeEach(() => {
    confirmDialogSpy.mockClear();
    selectState.onValueChange = undefined;
  });

  it("defaults to resolve-at-call-time even when static credentials exist", () => {
    useMcpServersGroupedByCatalogMock.mockReturnValue({
      "catalog-1": [personalCred],
    });
    const onValueChange = vi.fn();

    render(
      <TokenSelect
        value={null}
        onValueChange={onValueChange}
        catalogId="catalog-1"
        shouldSetDefaultValue={true}
      />,
    );

    expect(onValueChange).toHaveBeenCalledWith(DYNAMIC_CREDENTIAL_VALUE);
  });

  it("renders separate team, organization, and user static credential groups by scope", () => {
    const groupedCredentials = {
      "catalog-1": [
        {
          id: "team-credential",
          ownerEmail: "owner@example.com",
          scope: "team",
          teamDetails: { teamId: "team-1", name: "Scope Repro Team" },
        },
        {
          id: "organization-credential",
          ownerEmail: "admin@example.com",
          scope: "org",
          teamDetails: null,
        },
        {
          id: "user-credential",
          ownerEmail: "member@example.com",
          scope: "personal",
          teamDetails: null,
        },
      ],
    };
    useMcpServersGroupedByCatalogMock.mockReturnValue(groupedCredentials);

    render(
      <TokenSelect
        value={DYNAMIC_CREDENTIAL_VALUE}
        onValueChange={vi.fn()}
        catalogId="catalog-1"
        shouldSetDefaultValue={false}
      />,
    );

    expect(screen.getByText("Dynamic")).toBeInTheDocument();
    expect(
      screen.getByText("Static - Organization Credentials"),
    ).toBeInTheDocument();
    expect(screen.getByText("Organization")).toBeInTheDocument();
    expect(
      screen.getByText("Available to the organization"),
    ).toBeInTheDocument();
    expect(screen.getByText("Static - Team Credentials")).toBeInTheDocument();
    expect(
      screen.getByText("Shared with team Scope Repro Team"),
    ).toBeInTheDocument();
    expect(screen.getByText("Scope Repro Team")).toBeInTheDocument();
    expect(screen.getByText("Static - User Credentials")).toBeInTheDocument();
    expect(screen.getByText("member@example.com")).toBeInTheDocument();
    expect(screen.getByText("Owned by member@example.com")).toBeInTheDocument();
  });

  it("confirms before applying a personal credential on a shared agent, and applies it on confirm", () => {
    useMcpServersGroupedByCatalogMock.mockReturnValue({
      "catalog-1": [personalCred],
    });
    const onValueChange = vi.fn();

    render(
      <TokenSelect
        value={DYNAMIC_CREDENTIAL_VALUE}
        onValueChange={onValueChange}
        catalogId="catalog-1"
        shouldSetDefaultValue={false}
        agentScope="org"
      />,
    );

    fireEvent.click(screen.getByText("member@example.com"));

    // Gated: selection not applied yet, dialog shown with the right pin.
    expect(onValueChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("confirm-dialog")).toBeInTheDocument();
    expect(lastPins()).toEqual([
      {
        mcpName: "Everything",
        ownerEmail: "member@example.com",
        isCurrentUser: false,
      },
    ]);

    fireEvent.click(screen.getByText("confirm-pin"));
    expect(onValueChange).toHaveBeenCalledWith("user-cred");
  });

  it("does not apply the personal credential when the confirmation is cancelled", () => {
    useMcpServersGroupedByCatalogMock.mockReturnValue({
      "catalog-1": [personalCred],
    });
    const onValueChange = vi.fn();

    render(
      <TokenSelect
        value={DYNAMIC_CREDENTIAL_VALUE}
        onValueChange={onValueChange}
        catalogId="catalog-1"
        shouldSetDefaultValue={false}
        agentScope="org"
      />,
    );

    fireEvent.click(screen.getByText("member@example.com"));
    fireEvent.click(screen.getByText("cancel-pin"));

    expect(onValueChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument();
  });

  it("marks the selector's own connection as the current user in the confirmation", () => {
    useMcpServersGroupedByCatalogMock.mockReturnValue({
      "catalog-1": [ownPersonalCred],
    });

    render(
      <TokenSelect
        value={DYNAMIC_CREDENTIAL_VALUE}
        onValueChange={vi.fn()}
        catalogId="catalog-1"
        shouldSetDefaultValue={false}
        agentScope="team"
      />,
    );

    fireEvent.click(screen.getByText("me@example.com"));
    expect(lastPins()?.[0]?.isCurrentUser).toBe(true);
  });

  it("applies a personal credential without confirmation on a personal-scope agent", () => {
    useMcpServersGroupedByCatalogMock.mockReturnValue({
      "catalog-1": [personalCred],
    });
    const onValueChange = vi.fn();

    render(
      <TokenSelect
        value={DYNAMIC_CREDENTIAL_VALUE}
        onValueChange={onValueChange}
        catalogId="catalog-1"
        shouldSetDefaultValue={false}
        agentScope="personal"
      />,
    );

    fireEvent.click(screen.getByText("member@example.com"));
    expect(onValueChange).toHaveBeenCalledWith("user-cred");
    expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument();
  });

  it("applies an org/team credential on a shared agent without confirmation", () => {
    useMcpServersGroupedByCatalogMock.mockReturnValue({
      "catalog-1": [orgCred],
    });
    const onValueChange = vi.fn();

    render(
      <TokenSelect
        value={DYNAMIC_CREDENTIAL_VALUE}
        onValueChange={onValueChange}
        catalogId="catalog-1"
        shouldSetDefaultValue={false}
        agentScope="org"
      />,
    );

    fireEvent.click(screen.getByText("Organization"));
    expect(onValueChange).toHaveBeenCalledWith("org-cred");
    expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument();
  });
});
