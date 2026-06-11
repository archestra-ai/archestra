import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GithubAuthConfigFields } from "./github-auth-config-fields";

describe("GithubAuthConfigFields", () => {
  it("links to GitHub App settings when no configurations exist", async () => {
    render(
      <GithubAuthConfigFields
        authMethod="github_app"
        onAuthMethodChange={vi.fn()}
        githubAppConfigId=""
        onGithubAppConfigIdChange={vi.fn()}
        githubAppConfigs={[]}
      />,
    );

    expect(screen.getByText(/Create one in/)).toBeInTheDocument();
    expect(
      screen.getByRole("link", {
        name: "Settings → GitHub",
      }),
    ).toHaveAttribute("href", "/settings/github");
  });

  it("links to GitHub App settings when configurations exist", async () => {
    render(
      <GithubAuthConfigFields
        authMethod="github_app"
        onAuthMethodChange={vi.fn()}
        githubAppConfigId=""
        onGithubAppConfigIdChange={vi.fn()}
        githubAppConfigs={[{ id: "app-1", name: "Org app" }]}
      />,
    );

    expect(
      screen.getByRole("link", {
        name: "Settings → GitHub",
      }),
    ).toHaveAttribute("href", "/settings/github");
  });

  it("renders PAT fields only for PAT auth", async () => {
    const { rerender } = render(
      <GithubAuthConfigFields
        authMethod="pat"
        onAuthMethodChange={vi.fn()}
        githubAppConfigId=""
        onGithubAppConfigIdChange={vi.fn()}
        githubAppConfigs={[]}
        patFields={<div>PAT input</div>}
      />,
    );

    expect(screen.getByText("PAT input")).toBeInTheDocument();

    rerender(
      <GithubAuthConfigFields
        authMethod="github_app"
        onAuthMethodChange={vi.fn()}
        githubAppConfigId=""
        onGithubAppConfigIdChange={vi.fn()}
        githubAppConfigs={[]}
        patFields={<div>PAT input</div>}
      />,
    );

    expect(screen.queryByText("PAT input")).not.toBeInTheDocument();
  });
});
