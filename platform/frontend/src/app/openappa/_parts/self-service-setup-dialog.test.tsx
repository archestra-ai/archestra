import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { AppaGithubAppPermissions } from "@/lib/openappa-github-sync.query";
import { GithubAppPermissionsStep } from "./self-service-setup-dialog";

type Grants = AppaGithubAppPermissions;

/** A click path, by its whole text: its labels are separate elements. */
function clickPath(text: string) {
  return screen.queryByText(
    (_, element) =>
      element?.tagName === "SPAN" &&
      element.childElementCount > 1 &&
      element.textContent === text,
  );
}

const grants: Grants = {
  name: "Policy Sync",
  url: "https://github.com/apps/policy-sync",
  settingsUrl: "https://github.com/settings/apps/policy-sync/permissions",
  installationUrl: "https://github.com/settings/installations/7",
  permissions: [
    { name: "contents", granted: true },
    { name: "pull_requests", granted: true },
    { name: "checks", granted: true },
    { name: "workflows", granted: false },
  ],
};

test("shows only missing permission paths and opens the App and installation", () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  render(
    <GithubAppPermissionsStep
      grants={grants}
      loading={false}
      checking={false}
      ready={false}
      onCheckAgain={() => {}}
    />,
  );

  // What to do on GitHub reads as click paths, not as sentences.
  expect(
    clickPath("Repository permissions → Workflows → Read and write"),
  ).toBeVisible();
  expect(
    clickPath("Repository permissions → Checks → Read and write"),
  ).not.toBeInTheDocument();
  expect(screen.getByText("Save changes")).toBeVisible();
  expect(clickPath("Review request → Accept new permissions")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Update App" }));
  expect(open).toHaveBeenCalledWith(grants.settingsUrl, expect.any(String));
  fireEvent.click(screen.getByRole("button", { name: "Approve the request" }));
  expect(open).toHaveBeenLastCalledWith(
    grants.installationUrl,
    expect.any(String),
  );
});

test("Checks-only setup shows its path and rechecks from the status action", () => {
  const onCheckAgain = vi.fn();
  const props = {
    grants: {
      ...grants,
      permissions: [{ name: "checks" as const, granted: false }],
    },
    loading: false,
    checking: false,
    ready: false,
    onCheckAgain,
  };
  const { rerender } = render(<GithubAppPermissionsStep {...props} />);
  expect(
    clickPath("Repository permissions → Checks → Read and write"),
  ).toBeVisible();
  // Check again sits in the steps' own box, beside the status it reads again.
  const box = screen.getByRole("list").parentElement as HTMLElement;
  expect(within(box).getByText("Missing: Checks.")).toBeVisible();
  fireEvent.click(within(box).getByRole("button", { name: "Check again" }));
  expect(onCheckAgain).toHaveBeenCalledOnce();
  rerender(<GithubAppPermissionsStep {...props} checking />);
  expect(screen.getByRole("button", { name: "Check again" })).toBeDisabled();
  rerender(
    <GithubAppPermissionsStep
      {...props}
      ready
      grants={{
        ...props.grants,
        permissions: [{ name: "checks", granted: true }],
      }}
    />,
  );
  expect(
    screen.getByText("The Policy Sync App has the required permissions."),
  ).toBeVisible();
  expect(
    clickPath("Repository permissions → Checks → Read and write"),
  ).not.toBeInTheDocument();
});

test("permissions saved in the App's settings and not yet accepted leave only the approval to do", () => {
  render(
    <GithubAppPermissionsStep
      grants={{
        ...grants,
        permissions: [
          { name: "contents", granted: true, requested: true },
          { name: "pull_requests", granted: false, requested: true },
          { name: "checks", granted: false, requested: true },
          { name: "workflows", granted: true, requested: true },
        ],
      }}
      loading={false}
      checking={false}
      ready={false}
      onCheckAgain={() => {}}
    />,
  );
  // The first step is done: nothing is left to add in the App's settings.
  expect(screen.queryByRole("button", { name: "Update App" })).toBeNull();
  expect(
    clickPath("Repository permissions → Pull requests → Read and write"),
  ).not.toBeInTheDocument();
  // The second waits, and the status says what for.
  expect(
    screen.getByRole("button", { name: "Approve the request" }),
  ).toBeVisible();
  expect(clickPath("Review request → Accept new permissions")).toBeVisible();
  expect(
    screen.getByText("Waiting for approval: Pull requests and Checks."),
  ).toBeVisible();
});
