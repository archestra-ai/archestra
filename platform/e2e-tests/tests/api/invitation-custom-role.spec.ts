import { expect, test } from "./fixtures";

/**
 * E2E tests for invitation acceptance with custom roles
 *
 * These tests verify that when a user is invited with a custom role,
 * they are correctly assigned that role upon accepting the invitation.
 *
 * Note: Full end-to-end invitation acceptance would require:
 * 1. Creating a new user account
 * 2. Accepting the invitation via sign-up flow
 *
 * Since our e2e setup uses pre-existing authenticated users, these tests
 * verify the underlying API behavior for custom role assignment.
 */
test.describe("Invitation Custom Role Assignment", () => {
  test("should create invitation with custom role", async ({
    request,
    makeApiRequest,
    createRole,
    deleteRole,
    getActiveOrganizationId,
  }) => {
    const organizationId = await getActiveOrganizationId(request);
    const testEmail = `test-invite-${Date.now()}@example.com`;

    // Create a custom role
    const roleResponse = await createRole(request, {
      name: `invite_role_${Date.now()}`,
      permission: {
        profile: ["read"],
        tool: ["read"],
      },
    });
    const customRole = await roleResponse.json();

    try {
      // Create invitation with custom role
      const inviteResponse = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/auth/organization/invite-member",
        data: {
          email: testEmail,
          role: customRole.role,
          organizationId,
        },
      });

      expect(inviteResponse.status()).toBe(200);
      const invitation = await inviteResponse.json();

      expect(invitation.id).toBeDefined();
      expect(invitation.email).toBe(testEmail);
      expect(invitation.role).toBe(customRole.role);
      expect(invitation.status).toBe("pending");

      // Verify the invitation via the check endpoint
      const checkResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/invitation/${invitation.id}/check`,
      });

      expect(checkResponse.status()).toBe(200);
      const checkResult = await checkResponse.json();
      expect(checkResult.invitation.id).toBe(invitation.id);
      expect(checkResult.userExists).toBe(false);

      // Cancel the invitation to clean up
      await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/auth/organization/cancel-invitation",
        data: { invitationId: invitation.id },
      });
    } finally {
      // Clean up the custom role
      await deleteRole(request, customRole.id);
    }
  });

  test("should create invitation with predefined editor role", async ({
    request,
    makeApiRequest,
    getActiveOrganizationId,
  }) => {
    const organizationId = await getActiveOrganizationId(request);
    const testEmail = `test-editor-${Date.now()}@example.com`;

    // Create invitation with editor role
    const inviteResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/auth/organization/invite-member",
      data: {
        email: testEmail,
        role: "editor",
        organizationId,
      },
    });

    expect(inviteResponse.status()).toBe(200);
    const invitation = await inviteResponse.json();

    expect(invitation.id).toBeDefined();
    expect(invitation.email).toBe(testEmail);
    expect(invitation.role).toBe("editor");
    expect(invitation.status).toBe("pending");

    // Cancel the invitation to clean up
    await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/auth/organization/cancel-invitation",
      data: { invitationId: invitation.id },
    });
  });

  test("should create invitation with admin role", async ({
    request,
    makeApiRequest,
    getActiveOrganizationId,
  }) => {
    const organizationId = await getActiveOrganizationId(request);
    const testEmail = `test-admin-${Date.now()}@example.com`;

    // Create invitation with admin role
    const inviteResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/auth/organization/invite-member",
      data: {
        email: testEmail,
        role: "admin",
        organizationId,
      },
    });

    expect(inviteResponse.status()).toBe(200);
    const invitation = await inviteResponse.json();

    expect(invitation.id).toBeDefined();
    expect(invitation.email).toBe(testEmail);
    expect(invitation.role).toBe("admin");
    expect(invitation.status).toBe("pending");

    // Cancel the invitation to clean up
    await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/auth/organization/cancel-invitation",
      data: { invitationId: invitation.id },
    });
  });

  test("should list pending invitations with correct roles", async ({
    request,
    makeApiRequest,
    createRole,
    deleteRole,
    getActiveOrganizationId,
  }) => {
    const organizationId = await getActiveOrganizationId(request);
    const timestamp = Date.now();
    const customEmail = `test-list-custom-${timestamp}@example.com`;
    const editorEmail = `test-list-editor-${timestamp}@example.com`;

    // Create a custom role
    const roleResponse = await createRole(request, {
      name: `list_role_${timestamp}`,
      permission: {
        profile: ["read"],
      },
    });
    const customRole = await roleResponse.json();

    let customInvitation: { id: string } | undefined;
    let editorInvitation: { id: string } | undefined;

    try {
      // Create invitation with custom role
      const customInviteResponse = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/auth/organization/invite-member",
        data: {
          email: customEmail,
          role: customRole.role,
          organizationId,
        },
      });
      customInvitation = await customInviteResponse.json();

      // Create invitation with editor role
      const editorInviteResponse = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/auth/organization/invite-member",
        data: {
          email: editorEmail,
          role: "editor",
          organizationId,
        },
      });
      editorInvitation = await editorInviteResponse.json();

      // List invitations
      const listResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/auth/organization/list-invitations?organizationId=${organizationId}`,
      });

      expect(listResponse.status()).toBe(200);
      const invitations = await listResponse.json();

      // Find our test invitations
      const foundCustom = invitations.find(
        (inv: { email: string }) => inv.email === customEmail,
      );
      const foundEditor = invitations.find(
        (inv: { email: string }) => inv.email === editorEmail,
      );

      expect(foundCustom).toBeDefined();
      expect(foundCustom.role).toBe(customRole.role);
      expect(foundCustom.status).toBe("pending");

      expect(foundEditor).toBeDefined();
      expect(foundEditor.role).toBe("editor");
      expect(foundEditor.status).toBe("pending");
    } finally {
      // Clean up invitations
      if (customInvitation) {
        await makeApiRequest({
          request,
          method: "post",
          urlSuffix: "/api/auth/organization/cancel-invitation",
          data: { invitationId: customInvitation.id },
          ignoreStatusCheck: true,
        });
      }
      if (editorInvitation) {
        await makeApiRequest({
          request,
          method: "post",
          urlSuffix: "/api/auth/organization/cancel-invitation",
          data: { invitationId: editorInvitation.id },
          ignoreStatusCheck: true,
        });
      }
      // Clean up role
      await deleteRole(request, customRole.id);
    }
  });
});
