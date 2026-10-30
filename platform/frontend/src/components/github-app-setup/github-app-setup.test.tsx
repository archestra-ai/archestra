import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessSummary } from "./access-summary";
import {
  GithubAccountFields,
  readGithubAccountFields,
} from "./github-account-fields";
import { GithubAppChoice } from "./github-app-choice";
import { GithubAppPicker } from "./github-app-picker";
import { ManifestRow } from "./manifest-row";
import { shortGithubAppError } from "./short-error";

afterEach(() => {
  cleanup();
});

describe("GithubAccountFields", () => {
  function renderFields(fields: { githubUrl: string; organization: string }) {
    const read = readGithubAccountFields(fields);
    render(
      <GithubAccountFields
        idPrefix="t"
        {...fields}
        onGithubUrlChange={vi.fn()}
        onOrganizationChange={vi.fn()}
        organizationHelp="The GitHub organization with the Copilot plan."
        urlError={read.urlError}
        organizationError={read.organizationError}
      />,
    );
    return read;
  }

  it("asks for the GitHub and the organization, each with its hint", () => {
    renderFields({ githubUrl: "https://github.com", organization: "" });

    const url = screen.getByLabelText("GitHub URL");
    expect(url).toHaveAttribute("placeholder", "https://github.com");
    expect(url).toHaveAccessibleDescription(
      "Using GitHub Enterprise Server? Put its address here.",
    );
    const organization = screen.getByLabelText("Organization");
    expect(organization).toHaveAttribute("placeholder", "acme");
    expect(organization).toHaveAccessibleDescription(
      "The GitHub organization with the Copilot plan.",
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("names the account as the backend takes it, on github.com or Enterprise Server", () => {
    expect(
      readGithubAccountFields({
        githubUrl: "https://github.com",
        organization: "acme",
      }),
    ).toMatchObject({
      input: "acme",
      account: { login: "acme", dotCom: true },
    });
    expect(
      readGithubAccountFields({
        githubUrl: "https://git.example.com/some/path",
        organization: "https://git.example.com/acme/repo",
      }),
    ).toMatchObject({
      input: "https://git.example.com/acme",
      account: { login: "acme", api: "https://git.example.com/api/v3" },
    });
  });

  it("refuses a plain http GitHub only where https is required", () => {
    const fields = {
      githubUrl: "http://git.example.com",
      organization: "acme",
    };
    expect(
      readGithubAccountFields({ ...fields, httpsOnly: true }),
    ).toMatchObject({
      account: null,
      urlError: "Use an https:// address for GitHub.",
    });
    expect(readGithubAccountFields(fields)).toMatchObject({
      account: { login: "acme" },
      urlError: null,
    });
  });

  it("puts each field's error in place of its hint", () => {
    renderFields({ githubUrl: "not a url", organization: "-bad-" });

    expect(screen.getByLabelText("GitHub URL")).toHaveAccessibleDescription(
      "Enter a web address, like https://github.com.",
    );
    expect(screen.getByLabelText("GitHub URL")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(screen.getByLabelText("Organization")).toHaveAccessibleDescription(
      "Enter the organization's name on GitHub.",
    );
    expect(
      screen.queryByText(
        "Using GitHub Enterprise Server? Put its address here.",
      ),
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

  it("offers two choices, and a third to connect an App by its key when asked", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <GithubAppChoice
        icons={[null]}
        appName="My App"
        canCreate
        onUseExisting={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("button")).toHaveLength(2);

    const onConnectByKey = vi.fn();
    rerender(
      <GithubAppChoice
        icons={[null]}
        appName="My App"
        canCreate
        onUseExisting={vi.fn()}
        onCreate={vi.fn()}
        onConnectByKey={onConnectByKey}
      />,
    );
    expect(screen.getAllByRole("button")).toHaveLength(3);
    expect(
      screen.getByText("For an App that isn't connected to My App yet."),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", {
        name: /Connect an App by its ID and private key/,
      }),
    );
    expect(onConnectByKey).toHaveBeenCalledOnce();
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
    // The action keeps its place while waiting, but can't be used.
    expect(
      screen.getByRole("button", { name: "Create App" }).closest("[inert]"),
    ).not.toBeNull();
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
    // The error lies over the hint, which keeps its lines, so the row
    // keeps its height.
    expect(screen.getByRole("alert")).toHaveTextContent(
      "GitHub didn't return the new App.",
    );
    expect(screen.getByRole("alert")).toHaveAttribute(
      "title",
      "GitHub didn't return the new App.",
    );
    expect(screen.getByText(base.hint)).toHaveAttribute("aria-hidden", "true");
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

describe("shortGithubAppError", () => {
  it("puts each setup error in one short line, and keeps unknown ones", () => {
    expect(
      shortGithubAppError(
        "GitHub Copilot needs an organization on Copilot Business or Enterprise.",
      ),
    ).toBe("That's a personal account. Use an organization.");
    expect(shortGithubAppError("GitHub has no account named nope.")).toBe(
      "No such organization on this GitHub.",
    );
    expect(
      shortGithubAppError(
        "GitHub doesn't recognize App 42 with this private key. Check the App ID and download a current private key from the App settings.",
      ),
    ).toBe("GitHub doesn't know App 42 with this key.");
    expect(
      shortGithubAppError(
        "My Org Copilot isn't installed on my-org. Install it on the organization on GitHub, then try again.",
      ),
    ).toBe("My Org Copilot isn't installed on my-org.");
    expect(
      shortGithubAppError(
        "my-org doesn't allow Copilot requests from GitHub Apps. It needs Copilot Business or Enterprise, with requests from Apps allowed by an owner of the organization or its enterprise.",
      ),
    ).toBe("The organization doesn't allow Copilot requests from Apps.");
    expect(shortGithubAppError("Something else broke.")).toBe(
      "Something else broke.",
    );
  });
});
