import { E2eTestId, MEMBER_ROLE_NAME } from "@shared";
import { expect, test } from "../fixtures";

test("admin can impersonate a member and return to admin via banner", async ({
  goToAdminPage,
  adminPage,
}) => {
  await goToAdminPage("/settings/users");

  // Resolve the member user's id from the impersonation candidates endpoint —
  // the test ID for the "View as" button is suffixed with the user id.
  const candidatesResponse = await adminPage.evaluate(async () => {
    const res = await fetch("/api/user/impersonable");
    return await res.json();
  });

  const memberCandidate = (
    candidatesResponse as Array<{ id: string; role: string | null }>
  ).find((c) => c.role === MEMBER_ROLE_NAME);
  if (!memberCandidate) {
    throw new Error(
      "expected at least one member-role user to be impersonable",
    );
  }

  // Banner should not be visible yet.
  await expect(
    adminPage.getByTestId(E2eTestId.ImpersonationBanner),
  ).not.toBeVisible();

  // Start impersonation.
  await adminPage
    .getByTestId(`${E2eTestId.ImpersonationViewAsButton}-${memberCandidate.id}`)
    .click();

  // Banner appears.
  await expect(
    adminPage.getByTestId(E2eTestId.ImpersonationBanner),
  ).toBeVisible();

  // Stop impersonating.
  await adminPage.getByTestId(E2eTestId.ImpersonationStopButton).click();

  // Banner gone.
  await expect(
    adminPage.getByTestId(E2eTestId.ImpersonationBanner),
  ).not.toBeVisible();
});
