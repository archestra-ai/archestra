import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GithubPatFields } from "./github-pat-fields";

const noop = vi.fn();

function renderFields(props: Partial<Parameters<typeof GithubPatFields>[0]>) {
  return render(
    <GithubPatFields
      idPrefix="skill"
      pats={[]}
      patId=""
      onPatIdChange={noop}
      token=""
      onTokenChange={noop}
      tokenName=""
      onTokenNameChange={noop}
      purpose="scheduled syncs"
      {...props}
    />,
  );
}

describe("GithubPatFields", () => {
  // The defect this component was extracted to fix: both copies of these
  // fields reached the user as bare controls with no visible name.
  it("gives every credential control a label the user can see", () => {
    renderFields({
      pats: [{ id: "pat-1", name: "Org token" }],
      token: "ghp_typed",
    });

    expect(screen.getByLabelText("Saved token")).toBeInTheDocument();
    expect(screen.getByLabelText("Personal access token")).toBeInTheDocument();
    expect(screen.getByLabelText("Token name")).toBeInTheDocument();
  });

  it("asks for a token name only once a token has been pasted", () => {
    const { rerender } = renderFields({ token: "" });
    expect(screen.queryByLabelText("Token name")).not.toBeInTheDocument();

    rerender(
      <GithubPatFields
        idPrefix="skill"
        pats={[]}
        patId=""
        onPatIdChange={noop}
        token="ghp_typed"
        onTokenChange={noop}
        tokenName=""
        onTokenNameChange={noop}
        purpose="scheduled syncs"
      />,
    );
    expect(screen.getByLabelText("Token name")).toBeInTheDocument();
  });

  it("hides the paste fields while a saved token is selected", () => {
    renderFields({
      pats: [{ id: "pat-1", name: "Org token" }],
      patId: "pat-1",
    });

    expect(screen.getByLabelText("Saved token")).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Personal access token"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/stay authenticated with this saved token/),
    ).toBeInTheDocument();
  });

  it("namespaces field ids so two instances can share a page", () => {
    const { unmount } = renderFields({ token: "ghp_typed" });
    expect(screen.getByLabelText("Personal access token")).toHaveAttribute(
      "id",
      "skill-github-token",
    );
    unmount();

    renderFields({ idPrefix: "marketplace", token: "ghp_typed" });
    expect(screen.getByLabelText("Personal access token")).toHaveAttribute(
      "id",
      "marketplace-github-token",
    );
  });
});
