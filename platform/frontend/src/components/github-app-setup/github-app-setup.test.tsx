import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessSummary } from "./access-summary";
import { GithubAppChoice } from "./github-app-choice";
import { GithubAppPicker } from "./github-app-picker";
import { GithubOrganizationField } from "./github-organization-field";
import { ManifestRow } from "./manifest-row";

afterEach(() => {
  cleanup();
});

describe("GithubOrganizationField", () => {
  it("shows the help line, and an error in its place", () => {
    const { rerender } = render(
      <GithubOrganizationField
        id="org"
        value=""
        onChange={vi.fn()}
        error={null}
      />,
    );
    const field = screen.getByLabelText("GitHub organization");
    expect(field).toHaveAttribute(
      "placeholder",
      "acme or https://github.com/acme",
    );
    expect(field).toHaveAccessibleDescription(
      "Organization's GitHub handle or URL",
    );
    expect(screen.queryByRole("alert")).toBeNull();

    rerender(
      <GithubOrganizationField
        id="org"
        value="nope"
        onChange={vi.fn()}
        error="Enter an organization name or its GitHub address."
      />,
    );
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter an organization name or its GitHub address.",
    );
    expect(
      screen.queryByText("Organization's GitHub handle or URL"),
    ).toBeNull();
  });
});

describe("GithubAppChoice", () => {
  it("counts the connected Apps and offers a new one", async () => {
    const user = userEvent.setup();
    const onUseExisting = vi.fn();
    const onCreate = vi.fn();
    render(
      <GithubAppChoice
        icons={[null, null]}
        appName="My App"
        canCreate
        onUseExisting={onUseExisting}
        onCreate={onCreate}
      />,
    );

    expect(screen.getByText("2 connected to My App.")).toBeInTheDocument();
    expect(
      screen.getByText("A few clicks on GitHub. No keys to copy."),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /Use an App I already have/ }),
    );
    await user.click(
      screen.getByRole("button", { name: /Create a new GitHub App/ }),
    );
    expect(onUseExisting).toHaveBeenCalledOnce();
    expect(onCreate).toHaveBeenCalledOnce();
  });

  it("can't use an existing App when none is connected, nor create one without permission", () => {
    render(
      <GithubAppChoice
        icons={[]}
        appName="My App"
        canCreate={false}
        onUseExisting={vi.fn()}
        onCreate={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: /Use an App I already have/ }),
    ).toBeDisabled();
    expect(
      screen.getByText("Requires permission to create credentials."),
    ).toBeInTheDocument();
  });
});

describe("GithubAppPicker", () => {
  it("lists Apps with where each is installed", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <GithubAppPicker
        idPrefix="app"
        value=""
        onChange={onChange}
        apps={[
          { id: "a", name: "Policy Sync", icon: null, account: "my-org" },
          { id: "b", name: "Copilot", icon: null, account: "other-org" },
        ]}
      />,
    );

    expect(screen.getByText("other-org")).toBeInTheDocument();
    await user.click(screen.getByLabelText(/Copilot/));
    expect(onChange).toHaveBeenCalledWith("b");
  });
});

describe("ManifestRow", () => {
  const base = {
    index: 1,
    title: "Create the App on GitHub",
    hint: "Owned by my-org.",
    inlineAction: true,
    result: null,
    action: <button type="button">Create App</button>,
  };

  it("offers its action, then waits on GitHub with a way to check again", async () => {
    const user = userEvent.setup();
    const onCheckAgain = vi.fn();
    const { rerender } = render(
      <ol>
        <ManifestRow {...base} waiting={false} onCheckAgain={onCheckAgain} />
      </ol>,
    );
    expect(screen.getByText("Owned by my-org.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create App" })).toBeVisible();

    rerender(
      <ol>
        <ManifestRow {...base} waiting onCheckAgain={onCheckAgain} />
      </ol>,
    );
    expect(
      screen.getByText("Finish in the GitHub tab that opened."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create App" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Done? Check again" }));
    expect(onCheckAgain).toHaveBeenCalledOnce();
  });

  it("shows an error with Check again, and the result once done", () => {
    const { rerender } = render(
      <ol>
        <ManifestRow
          {...base}
          waiting={false}
          error="GitHub didn't return the new App."
          onCheckAgain={vi.fn()}
        />
      </ol>,
    );
    expect(
      screen.getByText("GitHub didn't return the new App."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check again" })).toBeVisible();

    rerender(
      <ol>
        <ManifestRow
          {...base}
          waiting={false}
          onCheckAgain={vi.fn()}
          result={<span>Created My Org Copilot</span>}
        />
      </ol>,
    );
    expect(screen.getByText("Created My Org Copilot")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create App" })).toBeNull();
  });
});

describe("AccessSummary", () => {
  it("says what the App may do, one badge per permission", () => {
    render(
      <AccessSummary
        intro="The App only needs the policy repository, nothing else in the organization:"
        permissions={[
          { name: "Contents", access: "Read & write" },
          { name: "Pull requests", access: "Read & write" },
        ]}
      />,
    );

    expect(
      screen.getByText(
        "The App only needs the policy repository, nothing else in the organization:",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Contents")).toBeInTheDocument();
    expect(screen.getByText("Pull requests")).toBeInTheDocument();
    expect(screen.getAllByText("Read & write")).toHaveLength(2);
  });
});
