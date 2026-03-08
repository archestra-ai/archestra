import { expect, test } from "./fixtures";

test.describe("Security Settings API", () => {
  // Run serially since tests modify shared organization settings
  test.describe.configure({ mode: "serial" });

  test("should update global tool policy to restrictive", async ({
    request,
    updateSecuritySettings,
  }) => {
    const response = await updateSecuritySettings(request, {
      globalToolPolicy: "restrictive",
    });

    const org = await response.json();
    expect(org.globalToolPolicy).toBe("restrictive");
  });

  test("should update global tool policy to permissive", async ({
    request,
    updateSecuritySettings,
  }) => {
    const response = await updateSecuritySettings(request, {
      globalToolPolicy: "permissive",
    });

    const org = await response.json();
    expect(org.globalToolPolicy).toBe("permissive");
  });

  test("should enable chat file uploads", async ({
    request,
    updateSecuritySettings,
  }) => {
    const response = await updateSecuritySettings(request, {
      allowChatFileUploads: true,
    });

    const org = await response.json();
    expect(org.allowChatFileUploads).toBe(true);
  });

  test("should disable chat file uploads", async ({
    request,
    updateSecuritySettings,
  }) => {
    const response = await updateSecuritySettings(request, {
      allowChatFileUploads: false,
    });

    const org = await response.json();
    expect(org.allowChatFileUploads).toBe(false);
  });

  test("should update both settings at once", async ({
    request,
    updateSecuritySettings,
  }) => {
    const response = await updateSecuritySettings(request, {
      globalToolPolicy: "restrictive",
      allowChatFileUploads: true,
    });

    const org = await response.json();
    expect(org.globalToolPolicy).toBe("restrictive");
    expect(org.allowChatFileUploads).toBe(true);
  });

  test("should read back security settings after update", async ({
    request,
    makeApiRequest,
    updateSecuritySettings,
  }) => {
    await updateSecuritySettings(request, {
      globalToolPolicy: "permissive",
      allowChatFileUploads: false,
    });

    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/organization",
    });

    const org = await response.json();
    expect(org.globalToolPolicy).toBe("permissive");
    expect(org.allowChatFileUploads).toBe(false);
  });

  // Clean up: reset to the same defaults that auth.admin.setup.ts sets
  test("cleanup: reset security settings to defaults", async ({
    request,
    updateSecuritySettings,
  }) => {
    await updateSecuritySettings(request, {
      globalToolPolicy: "restrictive",
      allowChatFileUploads: true,
    });
  });
});
