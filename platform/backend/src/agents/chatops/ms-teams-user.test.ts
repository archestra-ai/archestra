import { UserModel } from "@/models";
import { describe, expect, test, vi } from "@/test";
import { ensureProvisionedUser } from "./auto-provision";
import { resolveMSTeamsUserEmail } from "./ms-teams-user";

describe("Teams sign-in identity resolution", () => {
  test("reuses an SSO account when its UPN differs from mail", async ({
    makeUser,
    makeOrganization,
  }) => {
    await makeOrganization();
    const existing = await makeUser({ email: "login@example.com" });
    const email = await resolveMSTeamsUserEmail({
      email: "mail@example.com",
      userPrincipalName: "LOGIN@example.com",
    });
    const result = await ensureProvisionedUser({
      email: email ?? "",
      resolveDisplayName: vi.fn(async () => "Sample user"),
      provider: "ms-teams",
    });
    expect(result?.user.id).toBe(existing.id);
    expect(result?.invitationId).toBeNull();
    expect(await UserModel.findByEmail("mail@example.com")).toBeUndefined();
  });
  test("keeps the UPN identity when a separate mail account already exists", async ({
    makeUser,
  }) => {
    await makeUser({ email: "login@example.com" });
    await makeUser({ email: "mail@example.com" });
    expect(
      await resolveMSTeamsUserEmail({
        email: "mail@example.com",
        userPrincipalName: "login@example.com",
      }),
    ).toBe("login@example.com");
  });
  test("finds an existing mail account when the UPN has no match", async ({
    makeUser,
  }) => {
    await makeUser({ email: "mail@example.com" });
    expect(
      await resolveMSTeamsUserEmail({
        email: "MAIL@example.com",
        userPrincipalName: "login@example.com",
      }),
    ).toBe("mail@example.com");
  });
  test("preserves new-user mail preference and supports UPN-only identities", async () => {
    expect(
      await resolveMSTeamsUserEmail({
        email: " MAIL@example.com ",
        userPrincipalName: "login@example.com",
      }),
    ).toBe("mail@example.com");
    expect(
      await resolveMSTeamsUserEmail({ userPrincipalName: "LOGIN@example.com" }),
    ).toBe("login@example.com");
    expect(await resolveMSTeamsUserEmail({})).toBeNull();
  });
});
