import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  DYNAMIC_CREDENTIAL_VALUE,
  TokenSelect,
} from "@/components/token-select";

const { useMcpServersGroupedByCatalogMock } = vi.hoisted(() => ({
  useMcpServersGroupedByCatalogMock: vi.fn(),
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
  Select: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
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
    description,
  }: {
    children?: React.ReactNode;
    description?: React.ReactNode;
  }) => (
    <div>
      <div>{children}</div>
      {description ? <div>{description}</div> : null}
    </div>
  ),
}));

describe("TokenSelect", () => {
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
});
