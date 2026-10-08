import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  OpenAppaPolicyChange,
  OpenAppaPolicyCompletion,
} from "./openappa-policy-change";

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

test("shows only the changed hunks when the backend sends its diff", () => {
  render(
    <OpenAppaPolicyChange
      output={{
        structuredContent: {
          stage: "preview",
          delivery: "revision",
          before: "a\nb\nc\nd\ne\nf\ng\nh\n",
          after: "a\nb\nc\nd\ne\nf\ng\nH\n",
          diff: "--- a/p\n+++ b/p\n@@ -5,4 +5,4 @@\n e\n f\n g\n-h\n+H\n",
        },
      }}
    />,
  );

  const diff = screen.getByLabelText("Policy diff");
  expect(diff).toHaveTextContent("@@ -5,4 +5,4 @@");
  expect(diff).not.toHaveTextContent(" a b c");
});

test("shows the whole policy when a first preview keeps the starter as is", () => {
  render(
    <OpenAppaPolicyChange
      output={{
        structuredContent: {
          stage: "preview",
          delivery: "revision",
          before: "[policy]\nversion = 2\n",
          after: "[policy]\nversion = 2\n",
        },
      }}
    />,
  );

  expect(screen.queryByLabelText("Policy diff")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Policy")).toHaveTextContent(
    "[policy] version = 2",
  );
});

const saved = {
  delivery: "revision",
  revision: 1,
  before: "starter",
  after: "starter",
  enforcement: { enabled: true },
  effective: { error: null, batteries: [{ status: "active" }] },
};

test("confirmed publication offers a return action without opening the diff", () => {
  render(<OpenAppaPolicyCompletion output={{ structuredContent: saved }} />);
  expect(screen.getByText("Saved revision 1")).toBeInTheDocument();
  expect(screen.getByText(/Enforcement confirmed on/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "View Guardrails" })).toHaveAttribute(
    "href",
    "/openappa",
  );
  expect(screen.queryByLabelText("Policy diff")).not.toBeInTheDocument();
});

test.each([
  { ...saved, enforcement: { enabled: false } },
  { ...saved, effective: { error: "Composition failed", batteries: [] } },
  {
    ...saved,
    effective: { error: null, batteries: [{ status: "missing_credentials" }] },
  },
  { ...saved, enforcement: undefined },
  { ...saved, effective: undefined },
])("saved but unconfirmed results do not claim active protection", (output) => {
  render(<OpenAppaPolicyCompletion output={output} />);
  expect(screen.getByText("Saved revision 1")).toBeInTheDocument();
  expect(
    screen.queryByText(/Enforcement confirmed on/),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Check policy" })).toHaveAttribute(
    "href",
    "/openappa/policy",
  );
});

test.each([
  { ...saved, stage: "preview" },
  { ...saved, delivery: "pull_request", number: 4 },
  { ...saved, revision: 0 },
])("preview and pending PR do not appear as a saved local policy", (output) => {
  const { container } = render(<OpenAppaPolicyCompletion output={output} />);
  expect(container).toBeEmptyDOMElement();
});

test("published PR stays reviewable outside collapsed tool details", () => {
  render(
    <OpenAppaPolicyCompletion
      output={{
        delivery: "pull_request",
        number: 17,
        url: "https://github.com/example/policies/pull/17",
        before: "old",
        after: "new",
      }}
    />,
  );
  expect(
    screen.getByRole("link", { name: "Review pull request" }),
  ).toHaveAttribute("href", "https://github.com/example/policies/pull/17");
  expect(screen.queryByText(/Saved revision/)).not.toBeInTheDocument();
});
