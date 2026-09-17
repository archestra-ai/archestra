import { agentRuntimeError } from "@archestra/shared";
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { AgentRunDiagnostic } from "./agent-run-diagnostic";

it("explains an active authentication failure and links to the affected agent settings", () => {
  render(
    <AgentRunDiagnostic
      diagnostic={agentRuntimeError("codex_auth_required")}
      agentId="agent-1"
      failed={false}
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "ChatGPT sign-in has expired or was revoked.",
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Reconnect your ChatGPT account",
  );
  expect(screen.getByRole("link", { name: "Agent settings" })).toHaveAttribute(
    "href",
    "/agents/agent-1",
  );
  expect(screen.getByRole("alert")).not.toHaveTextContent("75");
});

it("gives a restart-specific resolution without claiming an authentication problem", () => {
  render(
    <AgentRunDiagnostic
      diagnostic={agentRuntimeError("runtime_restarted")}
      agentId="agent-1"
      failed
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("runtime restarted");
  expect(screen.getByRole("alert")).toHaveTextContent(
    "some actions may already have completed",
  );
  expect(screen.queryByRole("link", { name: "Agent settings" })).toBeNull();
});
