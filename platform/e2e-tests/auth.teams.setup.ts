import {
  type APIRequestContext,
  expect,
  test as setup,
} from "@playwright/test";
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  EDITOR_EMAIL,
  ENGINEERING_TEAM_NAME,
  MARKETING_TEAM_NAME,
  MEMBER_EMAIL,
  UI_BASE_URL,
} from "./consts";

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
  let delay = 1000;

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

    if (response.status() === 429 && attempt < maxRetries) {
      await sleep(delay);
      delay *= 2;
      continue;
    }

    return false;
  }

  return false;
}

interface OrgMember {
  id: string;
  userId: string;
  user: {
    id: string;
    email: string;
    name: string;
  };
}

/**
 * List organization members
 */
async function listOrgMembers(
  request: APIRequestContext,
): Promise<OrgMember[]> {
  const response = await request.get(
    `${UI_BASE_URL}/api/auth/organization/list-members`,
    {
      headers: { Origin: UI_BASE_URL },
    },
  );

  if (!response.ok()) {
    return [];
  }

  const data = await response.json();
  return data?.members ?? [];
}

interface Team {
  id: string;
  name: string;
  description: string | null;
}

/**
 * Get all teams in the organization
 */
async function getTeams(request: APIRequestContext): Promise<Team[]> {
  const response = await request.get(`${UI_BASE_URL}/api/teams`, {
    headers: { Origin: UI_BASE_URL },
  });

  if (!response.ok()) {
    return [];
  }

  return response.json();
}

/**
 * Create a team if it doesn't already exist
 * Returns the team (existing or newly created)
 */
async function createTeamIfNotExists(
  request: APIRequestContext,
  name: string,
  description: string,
  existingTeams: Team[],
): Promise<Team> {
  const existing = existingTeams.find((t) => t.name === name);
  if (existing) {
    return existing;
  }

  const response = await request.post(`${UI_BASE_URL}/api/teams`, {
    data: { name, description },
    headers: {
      "Content-Type": "application/json",
      Origin: UI_BASE_URL,
    },
  });

  if (!response.ok()) {
    throw new Error(`Failed to create team ${name}: ${await response.text()}`);
  }

  return response.json();
}

interface TeamMember {
  userId: string;
  role: string;
}

/**
 * Get members of a team
 */
async function getTeamMembers(
  request: APIRequestContext,
  teamId: string,
): Promise<TeamMember[]> {
  const response = await request.get(
    `${UI_BASE_URL}/api/teams/${teamId}/members`,
    {
      headers: { Origin: UI_BASE_URL },
    },
  );

  if (!response.ok()) {
    return [];
  }

  return response.json();
}

/**
 * Add a user to a team if not already a member
 */
async function addUserToTeamIfNotMember(
  request: APIRequestContext,
  teamId: string,
  userId: string,
  role: string,
  existingMembers: TeamMember[],
): Promise<void> {
  const isMember = existingMembers.some((m) => m.userId === userId);
  if (isMember) {
    return;
  }

  const response = await request.post(
    `${UI_BASE_URL}/api/teams/${teamId}/members`,
    {
      data: { userId, role },
      headers: {
        "Content-Type": "application/json",
        Origin: UI_BASE_URL,
      },
    },
  );

  if (!response.ok()) {
    throw new Error(
      `Failed to add user ${userId} to team ${teamId}: ${await response.text()}`,
    );
  }
}

// Setup teams - runs after users are created
setup("setup teams and assignments", async ({ page }) => {
  // Sign in as admin
  const signedIn = await signInUser(page.request, ADMIN_EMAIL, ADMIN_PASSWORD);
  expect(signedIn, "Admin sign-in failed for teams setup").toBe(true);

  // Navigate to establish cookie context
  await page.goto(`${UI_BASE_URL}/chat`);
  await page.waitForLoadState("networkidle");

  // Get organization members to find editor and member user IDs
  const members = await listOrgMembers(page.request);

  const editorMember = members.find((m) => m.user.email === EDITOR_EMAIL);
  const memberMember = members.find((m) => m.user.email === MEMBER_EMAIL);

  expect(editorMember, `Editor user ${EDITOR_EMAIL} not found`).toBeTruthy();
  expect(memberMember, `Member user ${MEMBER_EMAIL} not found`).toBeTruthy();

  const editorUserId = editorMember?.userId ?? "";
  const memberUserId = memberMember?.userId ?? "";

  // Get existing teams
  const existingTeams = await getTeams(page.request);

  // Create Engineering Team if not exists
  const engineeringTeam = await createTeamIfNotExists(
    page.request,
    ENGINEERING_TEAM_NAME,
    "Engineering team for e2e tests",
    existingTeams,
  );

  // Create Marketing Team if not exists
  const marketingTeam = await createTeamIfNotExists(
    page.request,
    MARKETING_TEAM_NAME,
    "Marketing team for e2e tests",
    existingTeams,
  );

  // Get team members
  const engineeringMembers = await getTeamMembers(
    page.request,
    engineeringTeam.id,
  );
  const marketingMembers = await getTeamMembers(page.request, marketingTeam.id);

  // Add Editor to both teams
  await addUserToTeamIfNotMember(
    page.request,
    engineeringTeam.id,
    editorUserId,
    "member",
    engineeringMembers,
  );
  await addUserToTeamIfNotMember(
    page.request,
    marketingTeam.id,
    editorUserId,
    "member",
    marketingMembers,
  );

  // Add Member only to Marketing Team
  await addUserToTeamIfNotMember(
    page.request,
    marketingTeam.id,
    memberUserId,
    "member",
    marketingMembers,
  );
});
