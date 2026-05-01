import {
  expect,
  test as setup,
} from "@playwright/test";
import { EDITOR_ROLE_NAME, MEMBER_ROLE_NAME } from "@shared";
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  EDITOR_EMAIL,
  EDITOR_PASSWORD,
  editorAuthFile,
  MEMBER_EMAIL,
  MEMBER_PASSWORD,
  memberAuthFile,
  UI_BASE_URL,
} from "./consts";
import {
  createInvitation,
  signInUser,
  signOut,
  signUpWithInvitation,
  sleep,
  userExists,
} from "./auth.setup.helpers";
import { expectAuthenticated } from "./utils";

// Run user setup tests sequentially to avoid rate limiting
setup.describe.configure({ mode: "serial" });

// Setup editor authentication - runs after admin setup
setup("authenticate as editor", async ({ page }) => {
  // Check if editor user already exists
  const editorExists = await userExists(
    page.request,
    EDITOR_EMAIL,
    EDITOR_PASSWORD,
  );

  if (!editorExists) {
    // Wait 100ms to avoid rate limiting after userExists check
    await sleep(100);

    // Sign in as admin to create invitation
    const adminSignedIn = await signInUser(
      page.request,
      ADMIN_EMAIL,
      ADMIN_PASSWORD,
    );
    expect(adminSignedIn, "Admin sign-in failed for editor setup").toBe(true);

    // Navigate to establish cookie context with organization
    await page.goto(`${UI_BASE_URL}/chat`);
    await page.waitForLoadState("domcontentloaded");

    // Create invitation for editor
    const invitationId = await createInvitation(
      page.request,
      EDITOR_EMAIL,
      EDITOR_ROLE_NAME,
    );

    // Sign out admin
    await signOut(page.request);

    // Sign up editor with invitation
    await signUpWithInvitation(
      page.request,
      EDITOR_EMAIL,
      EDITOR_PASSWORD,
      invitationId,
    );
  } else {
    // Editor exists, just sign in
    const signedIn = await signInUser(
      page.request,
      EDITOR_EMAIL,
      EDITOR_PASSWORD,
    );
    expect(signedIn, "Editor sign-in failed").toBe(true);
  }

  // Navigate to trigger cookie storage and verify auth
  await page.goto(`${UI_BASE_URL}/chat`);
  await page.waitForLoadState("domcontentloaded");

  // Verify we're authenticated
  await expectAuthenticated(page);

  // Save editor auth state
  await page.context().storageState({ path: editorAuthFile });
});

// Setup member authentication - runs after admin setup
setup("authenticate as member", async ({ page }) => {
  // Check if member user already exists
  const memberExists = await userExists(
    page.request,
    MEMBER_EMAIL,
    MEMBER_PASSWORD,
  );

  if (!memberExists) {
    // Wait 100ms to avoid rate limiting after userExists check
    await sleep(100);

    // Sign in as admin to create invitation
    const adminSignedIn = await signInUser(
      page.request,
      ADMIN_EMAIL,
      ADMIN_PASSWORD,
    );
    expect(adminSignedIn, "Admin sign-in failed for member setup").toBe(true);

    // Navigate to establish cookie context with organization
    await page.goto(`${UI_BASE_URL}/chat`);
    await page.waitForLoadState("domcontentloaded");

    // Create invitation for member
    const invitationId = await createInvitation(
      page.request,
      MEMBER_EMAIL,
      MEMBER_ROLE_NAME,
    );

    // Sign out admin
    await signOut(page.request);

    // Sign up member with invitation
    await signUpWithInvitation(
      page.request,
      MEMBER_EMAIL,
      MEMBER_PASSWORD,
      invitationId,
    );
  } else {
    // Member exists, just sign in
    const signedIn = await signInUser(
      page.request,
      MEMBER_EMAIL,
      MEMBER_PASSWORD,
    );
    expect(signedIn, "Member sign-in failed").toBe(true);
  }

  // Navigate to trigger cookie storage and verify auth
  await page.goto(`${UI_BASE_URL}/chat`);
  await page.waitForLoadState("domcontentloaded");

  // Verify we're authenticated
  await expectAuthenticated(page);

  // Save member auth state
  await page.context().storageState({ path: memberAuthFile });
});
