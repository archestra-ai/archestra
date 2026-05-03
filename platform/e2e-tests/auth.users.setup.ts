import {
  type APIRequestContext,
  expect,
  test as setup,
} from "@playwright/test";
import { EDITOR_ROLE_NAME, MEMBER_ROLE_NAME } from "@shared";
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  BASIC_USER_EMAIL,
  BASIC_USER_PASSWORD,
  BASIC_USER_ROLE_NAME,
  basicUserAuthFile,
  EDITOR_EMAIL,
  EDITOR_PASSWORD,
  editorAuthFile,
  MEMBER_EMAIL,
  MEMBER_PASSWORD,
  memberAuthFile,
  UI_BASE_URL,
} from "./consts";
import { expectAuthenticated } from "./utils";

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sign in a user via API and return true if successful
 * Handles rate limiting (429) with exponential backoff retry
 */
async function signInUser(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<boolean> {
  const maxRetries = 3;
  let delay = 1000; // Start with 1 second delay

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await request.post(
      `${UI_BASE_URL}/api/auth/sign-in/email`,
      {
        data: { email, password },
        headers: {
          Origin: UI_BASE_URL,
        },
      },
    );

    if (response.ok()) {
      return true;
    }

    // If rate limited and we have retries left, wait and retry
    if (response.status() === 429 && attempt < maxRetries) {
      await sleep(delay);
      delay *= 2; // Exponential backoff
      continue;
    }

    // For other errors or final retry, return false
    return false;
  }

  return false;
}

/**
 * Sign out the current user
 */
async function signOut(request: APIRequestContext): Promise<void> {
  await request.post(`${UI_BASE_URL}/api/auth/sign-out`);
}

/**
 * Get the active organization ID from the current session
 */
async function getActiveOrganizationId(
  request: APIRequestContext,
): Promise<string | null> {
  const response = await request.get(`${UI_BASE_URL}/api/auth/get-session`);
  if (!response.ok()) {
    return null;
  }
  const data = await response.json();
  return data?.session?.activeOrganizationId ?? null;
}

/**
 * Get existing invitation for a user
 */
async function getExistingInvitation(
  request: APIRequestContext,
  email: string,
  organizationId: string,
): Promise<string | null> {
  const response = await request.get(
    `${UI_BASE_URL}/api/auth/organization/list-invitations?organizationId=${organizationId}`,
    {
      headers: { Origin: UI_BASE_URL },
    },
  );
  if (!response.ok()) {
    return null;
  }
  const invitations = await response.json();
  const existing = invitations?.find(
    (inv: { email: string; status: string }) =>
      inv.email === email && inv.status === "pending",
  );
  return existing?.id ?? null;
}

/**
 * Create an invitation for a new user (must be called as admin)
 * If user is already invited, returns the existing invitation ID
 * @returns invitation ID or throws error with details
 */
async function createInvitation(
  request: APIRequestContext,
  email: string,
  role: string,
): Promise<string> {
  // Get the organization ID first
  const organizationId = await getActiveOrganizationId(request);
  if (!organizationId) {
    throw new Error(
      "Failed to get organization ID - admin may not be logged in",
    );
  }

  // Check if invitation already exists
  const existingInvitationId = await getExistingInvitation(
    request,
    email,
    organizationId,
  );
  if (existingInvitationId) {
    return existingInvitationId;
  }

  const response = await request.post(
    `${UI_BASE_URL}/api/auth/organization/invite-member`,
    {
      data: { email, role, organizationId },
      headers: {
        Origin: UI_BASE_URL,
      },
    },
  );

  if (!response.ok()) {
    const errorText = await response.text();
    if (errorText.includes("USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION")) {
      const existingInvitationId = await getExistingInvitation(
        request,
        email,
        organizationId,
      );

      if (existingInvitationId) {
        return existingInvitationId;
      }
    }

    throw new Error(
      `Invitation API failed (${response.status()}): ${errorText}`,
    );
  }

  const data = await response.json();
  return data.id;
}

/**
 * Sign up a new user with an invitation
 * The invitation ID is passed via callbackURL which better-auth uses to auto-accept
 * @returns true if successful, throws error with details on failure
 */
async function signUpWithInvitation(
  request: APIRequestContext,
  email: string,
  password: string,
  invitationId: string,
): Promise<boolean> {
  // Sign up with invitation - the callbackURL contains the invitation ID
  // which better-auth uses to auto-accept the invitation after sign-up
  const callbackURL = `${UI_BASE_URL}/auth/sign-up-with-invitation?invitationId=${invitationId}&email=${encodeURIComponent(email)}`;

  const signUpResponse = await request.post(
    `${UI_BASE_URL}/api/auth/sign-up/email`,
    {
      data: {
        email,
        password,
        name: email.split("@")[0],
        callbackURL,
      },
      headers: {
        Origin: UI_BASE_URL,
      },
    },
  );

  if (!signUpResponse.ok()) {
    const errorText = await signUpResponse.text();
    throw new Error(
      `Sign-up failed (${signUpResponse.status()}): ${errorText}\nCallbackURL: ${callbackURL}`,
    );
  }

  return true;
}

/**
 * Check if a user already exists by trying to sign in
 */
async function userExists(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<boolean> {
  const signedIn = await signInUser(request, email, password);
  if (signedIn) {
    await signOut(request);
  }
  return signedIn;
}

// Run user setup tests sequentially to avoid rate limiting
setup.describe.configure({ mode: "serial" });

// Setup editor authentication - runs after admin setup
setup.skip("authenticate as editor", async ({ page }) => {
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

/**
 * Permission set granted to the basic-user custom role.
 *
 * Deliberately slim — these are the permissions a restricted user
 * needs to access /chat once an admin has configured provider keys.
 * Used by chat-permissions.spec.ts to regression-test PR #4142.
 */
const BASIC_USER_PERMISSION = {
  agent: ["read"],
  chat: ["read"],
  llmProviderApiKey: ["read"],
  llmModel: ["read"],
} as const;

/**
 * Look up a custom role by display name. Returns the role's `id` (base62,
 * used by PUT/DELETE) and `role` (slug, used by invitations) if found.
 */
async function findCustomRole(
  request: APIRequestContext,
  name: string,
): Promise<{ id: string; role: string } | null> {
  const response = await request.get(
    `${UI_BASE_URL}/api/roles?name=${encodeURIComponent(name)}`,
    { headers: { Origin: UI_BASE_URL } },
  );
  if (!response.ok()) {
    return null;
  }
  const body = await response.json();
  const match = body?.data?.find(
    (role: { name: string; id: string; role: string }) => role.name === name,
  );
  if (!match?.id || !match?.role) {
    return null;
  }
  return { id: match.id, role: match.role };
}

/**
 * Create or refresh the basic-user custom role. Returns the role slug
 * (the value invitations require). Always rewrites the permission set so
 * that prior runs with a stale set cannot poison this run.
 */
async function ensureBasicUserRole(
  request: APIRequestContext,
): Promise<string> {
  const description = "Slim role used by chat-permissions e2e regression test";
  const existing = await findCustomRole(request, BASIC_USER_ROLE_NAME);

  if (existing) {
    const updateResponse = await request.put(
      `${UI_BASE_URL}/api/roles/${existing.id}`,
      {
        data: {
          name: BASIC_USER_ROLE_NAME,
          description,
          permission: BASIC_USER_PERMISSION,
        },
        headers: { Origin: UI_BASE_URL },
      },
    );
    if (!updateResponse.ok()) {
      const errorText = await updateResponse.text();
      throw new Error(
        `Failed to refresh basic-user role permissions (${updateResponse.status()}): ${errorText}`,
      );
    }
    return existing.role;
  }

  const response = await request.post(`${UI_BASE_URL}/api/roles`, {
    data: {
      name: BASIC_USER_ROLE_NAME,
      description,
      permission: BASIC_USER_PERMISSION,
    },
    headers: { Origin: UI_BASE_URL },
  });

  if (!response.ok()) {
    const errorText = await response.text();
    throw new Error(
      `Failed to create basic-user custom role (${response.status()}): ${errorText}`,
    );
  }

  const created = await response.json();
  if (!created?.role) {
    throw new Error(
      `Basic-user role create response missing 'role' field: ${JSON.stringify(created)}`,
    );
  }
  return created.role;
}

// Setup member authentication - runs after admin setup
setup.skip("authenticate as member", async ({ page }) => {
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

// Setup basic-user authentication (custom role with slim permissions)
setup.skip("authenticate as basic-user (custom role)", async ({ page }) => {
  const basicUserExists = await userExists(
    page.request,
    BASIC_USER_EMAIL,
    BASIC_USER_PASSWORD,
  );

  // Always sign in as admin first so we can refresh the basic-user role's
  // permission set on every run. Without this, prior runs that created the
  // role with a stale permission set would persist and break the test.
  await sleep(100);
  const adminSignedIn = await signInUser(
    page.request,
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
  );
  expect(adminSignedIn, "Admin sign-in failed for basic-user setup").toBe(true);

  // Establish cookie context with active organization
  await page.goto(`${UI_BASE_URL}/chat`);
  await page.waitForLoadState("domcontentloaded");

  // Ensure the custom role exists with the current permission set
  const basicUserRoleIdentifier = await ensureBasicUserRole(page.request);

  if (!basicUserExists) {
    // Invite basic user with the custom role identifier
    const invitationId = await createInvitation(
      page.request,
      BASIC_USER_EMAIL,
      basicUserRoleIdentifier,
    );

    await signOut(page.request);

    await signUpWithInvitation(
      page.request,
      BASIC_USER_EMAIL,
      BASIC_USER_PASSWORD,
      invitationId,
    );
  } else {
    await signOut(page.request);

    const signedIn = await signInUser(
      page.request,
      BASIC_USER_EMAIL,
      BASIC_USER_PASSWORD,
    );
    expect(signedIn, "Basic-user sign-in failed").toBe(true);
  }

  await page.goto(`${UI_BASE_URL}/chat`);
  await page.waitForLoadState("domcontentloaded");

  await expectAuthenticated(page);

  await page.context().storageState({ path: basicUserAuthFile });
});
