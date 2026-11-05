// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { ROLE_ASSIGNMENT_BLOCKED_CODE } from "@archestra/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { RoleAssignmentBlockedNotice } from "./role-assignment-blocked-notice";

const details = {
  subjectType: "role",
  total: 3,
  items: [
    {
      resource: "agent",
      scope: "00000000-0000-4000-8000-000000000001",
      name: "Support Triage",
      missing: ["manage-permissions"],
    },
    {
      resource: "environment",
      scope: "00000000-0000-4000-8000-000000000002",
      name: "Production",
      missing: ["use", "manage-permissions"],
    },
  ],
};

function renderNotice(error: unknown) {
  return render(
    <TooltipProvider>
      <RoleAssignmentBlockedNotice error={error} name="Member" />
    </TooltipProvider>,
  );
}

describe("RoleAssignmentBlockedNotice", () => {
  it("explains a refusal from the API client and names each item", () => {
    renderNotice({
      error: {
        message: "refused",
        type: "api_authorization_error",
        internal_code: ROLE_ASSIGNMENT_BLOCKED_CODE,
        details,
      },
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Can’t assign Member");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "You don’t have manage-permissions on these 3 items.",
    );
    expect(
      screen.getByRole("link", { name: "Support Triage" }),
    ).toHaveAttribute("href", "/agents/00000000-0000-4000-8000-000000000001");
    // Environments have no detail page, so the name is plain text.
    expect(screen.getByText("Production")).not.toHaveAttribute("href");
    expect(screen.getByText("and 1 more")).toBeInTheDocument();
  });

  it("explains a refusal from the better-auth client", () => {
    renderNotice({
      code: ROLE_ASSIGNMENT_BLOCKED_CODE,
      message: "refused",
      details,
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Can’t assign Member");
  });

  it("renders nothing for any other error", () => {
    const { container } = renderNotice(new Error("Network error"));

    expect(container).toBeEmptyDOMElement();
  });
});
