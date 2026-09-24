import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { OpenAppaPolicyChange } from "./openappa-policy-change";

test("shows a policy preview from the chat tool's text result", () => {
  render(
    <OpenAppaPolicyChange
      output={{
        content: JSON.stringify({
          stage: "preview",
          delivery: "revision",
          before: "[policy]\nversion = 2\n",
          after:
            '[policy]\nversion = 2\n[[policy.tool]]\nname = "example__search"\n',
        }),
      }}
    />,
  );

  expect(screen.getByText("Proposed policy")).toBeInTheDocument();
  expect(screen.getByText("Local revision")).toBeInTheDocument();
  expect(screen.getByLabelText("Policy diff")).toHaveTextContent(
    '+name = "example__search"',
  );
});

test("shows a reviewable policy diff and the pull request link", () => {
  render(
    <OpenAppaPolicyChange
      output={{
        structuredContent: {
          delivery: "pull_request",
          number: 17,
          url: "https://github.com/example/policies/pull/17",
          path: "guardrails/appa.toml",
          before: '[policy]\nversion = 2\nname = "old"\n',
          after: '[policy]\nversion = 2\nname = "new"\n',
        },
      }}
    />,
  );

  expect(screen.getByText("PR #17")).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "Review pull request" }),
  ).toHaveAttribute("href", "https://github.com/example/policies/pull/17");
  expect(screen.getByLabelText("Policy diff")).toHaveTextContent(
    '-name = "old"',
  );
  expect(screen.getByLabelText("Policy diff")).toHaveTextContent(
    '+name = "new"',
  );
});
