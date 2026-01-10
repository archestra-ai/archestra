import { DEFAULT_THEME_ID } from "@shared";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import OrganizationModel from "./organization";

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
      const testLogo = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";

      // Update organization with logo
      await db
        .update(schema.organizationsTable)
        .set({ logo: testLogo })
        .where(eq(schema.organizationsTable.id, org.id));

      const appearance = await OrganizationModel.getPublicAppearance();

      expect(appearance.logo).toBe(testLogo);
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

    test("should reject non-PNG logo", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      await expect(
        OrganizationModel.patch(org.id, {
          logo: "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
        }),
      ).rejects.toThrow("Logo must be a PNG image in base64 format");
    });

    test("should accept valid PNG logo", async ({ makeOrganization }) => {
      const org = await makeOrganization();
      const validLogo =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";

      const updated = await OrganizationModel.patch(org.id, {
        logo: validLogo,
      });

      expect(updated?.logo).toBe(validLogo);
    });

    test("should return null for non-existent organization", async () => {
      const updated = await OrganizationModel.patch("non-existent-id", {
        theme: "twitter",
      });

      expect(updated).toBeNull();
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
