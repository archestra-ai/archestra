import { DEFAULT_THEME_ID } from "@shared";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import { UpdateOrganizationSchema } from "@/types";
import OrganizationModel from "./organization";

// Minimal valid 1x1 transparent PNG (Base64-encoded)
const VALID_PNG_BASE64 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+hc2rNAAAAABJRU5ErkJggg==";

describe("OrganizationModel", () => {
  describe("getPublicAppearance", () => {
    test("should return default appearance when no organization exists", async () => {
      // Ensure no organizations exist (test setup clears DB)
      const appearance = await OrganizationModel.getPublicAppearance();

      expect(appearance).toEqual({
        theme: DEFAULT_THEME_ID,
        customFont: "lato",
        logo: null,
      });
    });

    test("should return organization appearance settings", async ({
      makeOrganization,
    }) => {
      await makeOrganization();

      const appearance = await OrganizationModel.getPublicAppearance();

      expect(appearance).toEqual({
        theme: "cosmic-night",
        customFont: "lato",
        logo: null,
      });
    });

    test("should return custom theme when set", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      // Update organization with custom theme
      await db
        .update(schema.organizationsTable)
        .set({ theme: "twitter" })
        .where(eq(schema.organizationsTable.id, org.id));

      const appearance = await OrganizationModel.getPublicAppearance();

      expect(appearance.theme).toBe("twitter");
    });

    test("should return custom font when set", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      // Update organization with custom font
      await db
        .update(schema.organizationsTable)
        .set({ customFont: "inter" })
        .where(eq(schema.organizationsTable.id, org.id));

      const appearance = await OrganizationModel.getPublicAppearance();

      expect(appearance.customFont).toBe("inter");
    });

    test("should return logo when set", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      // Update organization with logo
      await db
        .update(schema.organizationsTable)
        .set({ logo: VALID_PNG_BASE64 })
        .where(eq(schema.organizationsTable.id, org.id));

      const appearance = await OrganizationModel.getPublicAppearance();

      expect(appearance.logo).toBe(VALID_PNG_BASE64);
    });

    test("should return first organization's appearance when multiple exist", async ({
      makeOrganization,
    }) => {
      // Create first organization with custom settings
      const firstOrg = await makeOrganization();
      await db
        .update(schema.organizationsTable)
        .set({ theme: "claude", customFont: "roboto" })
        .where(eq(schema.organizationsTable.id, firstOrg.id));

      // Create second organization with different settings
      await makeOrganization();

      const appearance = await OrganizationModel.getPublicAppearance();

      // Should return first organization's appearance
      expect(appearance.theme).toBe("claude");
      expect(appearance.customFont).toBe("roboto");
    });

    test("should only return theme, customFont, and logo fields", async ({
      makeOrganization,
    }) => {
      await makeOrganization();

      const appearance = await OrganizationModel.getPublicAppearance();

      // Verify only expected fields are returned
      expect(Object.keys(appearance).sort()).toEqual([
        "customFont",
        "logo",
        "theme",
      ]);
    });
  });

  describe("getOrCreateDefaultOrganization", () => {
    test("should create default organization when none exists", async () => {
      const org = await OrganizationModel.getOrCreateDefaultOrganization();

      expect(org).toBeDefined();
      expect(org.id).toBe("default-org");
      expect(org.name).toBe("Default Organization");
      expect(org.slug).toBe("default");
    });

    test("should return existing organization when one exists", async ({
      makeOrganization,
    }) => {
      const existingOrg = await makeOrganization();

      const org = await OrganizationModel.getOrCreateDefaultOrganization();

      expect(org.id).toBe(existingOrg.id);
    });
  });

  describe("patch", () => {
    test("should update organization theme", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      const updated = await OrganizationModel.patch(org.id, {
        theme: "twitter",
      });

      expect(updated?.theme).toBe("twitter");
    });

    test("should update organization font", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      const updated = await OrganizationModel.patch(org.id, {
        customFont: "inter",
      });

      expect(updated?.customFont).toBe("inter");
    });

    test("should accept valid PNG logo", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      const updated = await OrganizationModel.patch(org.id, {
        logo: VALID_PNG_BASE64,
      });

      expect(updated?.logo).toBe(VALID_PNG_BASE64);
    });

    test("should accept null logo (removal)", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      // First set a logo
      await OrganizationModel.patch(org.id, { logo: VALID_PNG_BASE64 });

      // Then remove it
      const updated = await OrganizationModel.patch(org.id, { logo: null });

      expect(updated?.logo).toBeNull();
    });

    test("should return null for non-existent organization", async () => {
      const updated = await OrganizationModel.patch("non-existent-id", {
        theme: "twitter",
      });

      expect(updated).toBeNull();
    });

    test("should return unchanged organization when data is empty", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      // Patch with empty object should not throw "No values to set"
      const updated = await OrganizationModel.patch(org.id, {});

      expect(updated).not.toBeNull();
      expect(updated?.id).toBe(org.id);
      expect(updated?.theme).toBe(org.theme);
    });

    test("should return null when patching non-existent org with empty data", async () => {
      const updated = await OrganizationModel.patch("non-existent-id", {});

      expect(updated).toBeNull();
    });
  });

  describe("patch logo validation (via UpdateOrganizationSchema)", () => {
    const parseLogoField = (logo: string | null) =>
      UpdateOrganizationSchema.shape.logo.safeParse(logo);

    describe("MIME type validation", () => {
      test("should reject non-PNG data URI prefix", () => {
        const result = parseLogoField(
          "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
        );

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues).toHaveLength(1);
          expect(result.error.issues[0].message).toContain("PNG");
        }
      });

      test("should reject WebP data URI prefix", () => {
        const result = parseLogoField(
          "data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAQAcJaQAA3AA/v3AgAA",
        );

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues).toHaveLength(1);
          expect(result.error.issues[0].message).toContain("PNG");
        }
      });
    });

    describe("Base64 validation", () => {
      test("should reject invalid Base64 payload", () => {
        const result = parseLogoField(
          "data:image/png;base64,NotAnImageJustText",
        );

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues).toHaveLength(1);
          expect(result.error.issues[0].message).toContain("Base64");
        }
      });

      test("should reject valid Base64 but non-PNG content", () => {
        // "Hello World" encoded as Base64 — valid Base64 but not a PNG
        const result = parseLogoField("data:image/png;base64,SGVsbG8gV29ybGQ=");

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues).toHaveLength(1);
          expect(result.error.issues[0].message).toContain("PNG image data");
        }
      });
    });

    describe("Format validation", () => {
      test("should reject plain text without data URI prefix", () => {
        const result = parseLogoField("just-a-random-string");

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues).toHaveLength(1);
          expect(result.error.issues[0].message).toContain("data URI");
        }
      });

      test("should reject empty string", () => {
        const result = parseLogoField("");

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues).toHaveLength(1);
          expect(result.error.issues[0].message).toContain("data URI");
        }
      });

      test("should reject malformed data URI", () => {
        const result = parseLogoField("data:image/png;");

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues).toHaveLength(1);
        }
      });
    });

    describe("Valid inputs", () => {
      test("should accept null", () => {
        const result = parseLogoField(null);

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toBeNull();
        }
      });

      test("should accept valid PNG data URI", () => {
        const result = parseLogoField(VALID_PNG_BASE64);

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toBe(VALID_PNG_BASE64);
        }
      });
    });
  });

  describe("getById", () => {
    test("should return organization by id", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      const found = await OrganizationModel.getById(org.id);

      expect(found?.id).toBe(org.id);
      expect(found?.name).toBe(org.name);
    });

    test("should return null for non-existent id", async () => {
      const found = await OrganizationModel.getById("non-existent-id");

      expect(found).toBeNull();
    });
  });
});
