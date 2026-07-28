import type { McpExecutedAs } from "@archestra/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ExecutedAsBadge } from "./executed-as-badge";

describe("ExecutedAsBadge", () => {
  it("names the owner of the connection the call ran through", () => {
    render(
      <ExecutedAsBadge
        executedAs={{
          kind: "personal",
          ownerUserId: "user-2",
          ownerName: "Grace Hopper",
        }}
        meUserId="user-1"
      />,
    );

    expect(screen.getByText("Ran as Grace Hopper")).toBeInTheDocument();
  });

  it("says the call ran as me when I own the connection", () => {
    render(
      <ExecutedAsBadge
        executedAs={{
          kind: "personal",
          ownerUserId: "user-1",
          ownerName: "Ada Lovelace",
        }}
        meUserId="user-1"
      />,
    );

    expect(screen.getByText("Ran as me")).toBeInTheDocument();
  });

  it("names the owner rather than me when no viewer is given", () => {
    render(
      <ExecutedAsBadge
        executedAs={{
          kind: "personal",
          ownerUserId: "user-1",
          ownerName: "Ada Lovelace",
        }}
      />,
    );

    expect(screen.getByText("Ran as Ada Lovelace")).toBeInTheDocument();
  });

  it.each([
    [
      { kind: "personal", ownerUserId: null, ownerName: null },
      "Ran as a personal connection",
    ],
    [
      { kind: "team", teamId: "team-1", teamName: "Platform Team" },
      "Ran as Platform Team",
    ],
    [{ kind: "team", teamId: "team-1", teamName: null }, "Ran as a team"],
    [{ kind: "org" }, "Ran as the organization"],
    [{ kind: "idp_exchange" }, "Ran as the caller"],
    [{ kind: "idp_passthrough" }, "Ran as the caller"],
    [{ kind: "caller_headers" }, "Ran as the caller"],
  ] as Array<
    [McpExecutedAs, string]
  >)("labels a %o identity", (executedAs, label) => {
    render(<ExecutedAsBadge executedAs={executedAs} meUserId="user-1" />);

    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("renders nothing for a call that resolved no upstream credential", () => {
    const { container } = render(<ExecutedAsBadge executedAs={null} />);

    expect(container).toBeEmptyDOMElement();
  });
});
