import type { APIRequestContext } from "@playwright/test";
import { ArchestraApi } from "./api";
import { ARCHESTRA_URL } from "./env";

/**
 * Screenshots are taken as a seeded persona, never as the instance's own admin:
 * the sidebar shows a realistic name, and capturing never touches the admin's
 * account or credentials on a developer's instance.
 */
export const PERSONA = {
  name: "Jordan Ellis",
  email: "jordan.ellis@example.com",
  password:
    process.env.DOCS_SCREENSHOTS_PERSONA_PASSWORD ?? "docs-screenshots-Persona-1",
  role: "admin",
} as const;

/** Invites the persona (as the signed-in admin) and signs it up, if it doesn't exist yet. */
export async function ensurePersona(params: {
  admin: ArchestraApi;
  anonymous: APIRequestContext;
}): Promise<void> {
  const probe = new ArchestraApi(params.anonymous);
  if (await probe.signIn(PERSONA.email, PERSONA.password)) {
    await probe.signOut();
    return;
  }

  const session = await params.admin.get<{
    session: { activeOrganizationId: string };
  }>("/api/auth/get-session");
  const organizationId = session.session.activeOrganizationId;

  const invitations = await params.admin.get<
    { id: string; email: string; status: string }[]
  >(`/api/auth/organization/list-invitations?organizationId=${organizationId}`);
  let invitationId = invitations.find(
    (invite) => invite.email === PERSONA.email && invite.status === "pending",
  )?.id;
  if (!invitationId) {
    const invite = await params.admin.post<{ id: string }>(
      "/api/auth/organization/invite-member",
      { email: PERSONA.email, role: PERSONA.role, organizationId },
    );
    invitationId = invite.id;
  }

  // Better Auth accepts the invitation from the sign-up callback URL.
  const callbackURL = `${ARCHESTRA_URL}/auth/sign-up-with-invitation?invitationId=${invitationId}&email=${encodeURIComponent(PERSONA.email)}`;
  await probe.post("/api/auth/sign-up/email", {
    email: PERSONA.email,
    password: PERSONA.password,
    name: PERSONA.name,
    callbackURL,
  });
  await probe.signOut();
}
