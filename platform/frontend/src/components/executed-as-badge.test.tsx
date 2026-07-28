import type { McpExecutedAs } from "@archestra/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { scopeStyles } from "@/components/resource-visibility-badge";
import { useAppName } from "@/lib/hooks/use-app-name";
import { ExecutedAsBadge } from "./executed-as-badge";

vi.mock("@/lib/hooks/use-app-name");

describe("ExecutedAsBadge", () => {
  beforeEach(() => {
    vi.mocked(useAppName).mockReturnValue("Acme AI");
  });

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

    expect(screen.getByText("Grace Hopper")).toBeInTheDocument();
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

    expect(screen.getByText("Me")).toBeInTheDocument();
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

    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
  });

  it.each([
    [
      { kind: "personal", ownerUserId: null, ownerName: null },
      "Personal connection",
    ],
    [
      { kind: "team", teamId: "team-1", teamName: "Platform Team" },
      "Platform Team",
    ],
    [{ kind: "team", teamId: "team-1", teamName: null }, "Team"],
    [{ kind: "org" }, "Organization"],
    [{ kind: "idp_exchange", callerUserId: "user-1" }, "Me"],
    [{ kind: "idp_passthrough", callerUserId: "user-2" }, "The caller"],
    [{ kind: "caller_headers", callerUserId: "user-1" }, "Me"],
    [{ kind: "platform", callerUserId: "user-1" }, "Me"],
    [{ kind: "platform", callerUserId: "user-2" }, "The caller"],
    [{ kind: "platform", callerUserId: null }, "The caller"],
  ] as Array<
    [McpExecutedAs, string]
  >)("labels a %o identity", (executedAs, label) => {
    render(<ExecutedAsBadge executedAs={executedAs} meUserId="user-1" />);

    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("names the caller on a call Archestra ran itself", () => {
    render(
      <ExecutedAsBadge
        executedAs={{ kind: "platform", callerUserId: "user-2" }}
        meUserId="user-1"
        caller={{ label: "Grace Hopper", scope: "personal" }}
      />,
    );

    expect(screen.getByText("Grace Hopper")).toBeInTheDocument();
  });

  it("draws a gateway token as its own scope, not as a person", async () => {
    const user = userEvent.setup();
    render(
      <ExecutedAsBadge
        executedAs={{ kind: "platform", callerUserId: null }}
        caller={{ label: "Org Token", scope: "org" }}
      />,
    );

    // A token belongs to the organization, so it must not wear the personal
    // peel that names somebody's own connection.
    const label = screen.getByText("Org Token");
    expect(label.closest("span")?.parentElement).toHaveClass(
      ...scopeStyles.org.split(" "),
    );
    await user.hover(label);
    expect(
      await screen.findAllByText(
        "This call used the Org Token to reach the Acme AI",
      ),
    ).not.toHaveLength(0);
  });

  it("describes a platform-served call with the deployment's own name", async () => {
    const user = userEvent.setup();
    render(
      <ExecutedAsBadge
        executedAs={{ kind: "platform", callerUserId: "user-1" }}
        meUserId="user-1"
      />,
    );

    await user.hover(screen.getByText("Me"));

    // White-labeled deployments must not read "Archestra" here. Radix renders
    // the copy twice (visible plus a screen-reader node).
    expect(
      await screen.findAllByText(
        "This call used your own connection to the Acme AI",
      ),
    ).not.toHaveLength(0);
  });

  it("names the caller for an auditor, who is not the caller", () => {
    render(
      <ExecutedAsBadge
        executedAs={{ kind: "platform", callerUserId: "user-2" }}
        caller={{ label: "Grace Hopper", scope: "personal" }}
      />,
    );

    // The tool-call log passes no viewer, so nothing ever reads as "Me" there.
    expect(screen.getByText("Grace Hopper")).toBeInTheDocument();
    expect(screen.queryByText("Me")).not.toBeInTheDocument();
  });

  it("renders nothing for a call that resolved no upstream credential", () => {
    const { container } = render(<ExecutedAsBadge executedAs={null} />);

    expect(container).toBeEmptyDOMElement();
  });
});
