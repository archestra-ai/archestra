import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DYNAMIC_CREDENTIAL_VALUE,
  TokenSelect,
} from "@/components/token-select";

const { useMcpServersGroupedByCatalogMock, selectState } = vi.hoisted(() => ({
  useMcpServersGroupedByCatalogMock: vi.fn(),
  // Captures the mocked Select's onValueChange so a SelectItem "click" can
  // drive it (the real Radix Select can't be exercised in jsdom).
  selectState: {
    onValueChange: undefined as ((v: string) => void) | undefined,
  },
}));

vi.mock("@/lib/mcp/mcp-server.query", () => ({
  useMcpServersGroupedByCatalog: useMcpServersGroupedByCatalogMock,
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
const orgCred = {
  id: "org-cred",
  ownerEmail: "admin@example.com",
  ownerId: "admin-user",
  scope: "org",
  catalogName: "Everything",
  name: "Everything",
  teamDetails: null,
};

describe("TokenSelect", () => {
  beforeEach(() => {
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

  it("renders shared credentials but never personal connections", () => {
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
    expect(
      screen.queryByText("Static - User Credentials"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("member@example.com")).not.toBeInTheDocument();
  });

  it("shows no static option when only personal connections exist", () => {
    useMcpServersGroupedByCatalogMock.mockReturnValue({
      "catalog-1": [personalCred],
    });
    render(
      <TokenSelect
        value={DYNAMIC_CREDENTIAL_VALUE}
        onValueChange={vi.fn()}
        catalogId="catalog-1"
        shouldSetDefaultValue={false}
      />,
    );

    expect(
      screen.getByText("No shared credentials for this server."),
    ).toBeInTheDocument();
    expect(screen.queryByText("member@example.com")).not.toBeInTheDocument();
  });

  it("applies an org/team credential without confirmation", () => {
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
      />,
    );

    fireEvent.click(screen.getByText("Organization"));
    expect(onValueChange).toHaveBeenCalledWith("org-cred");
  });
});
