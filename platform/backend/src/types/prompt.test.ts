import { describe, expect, it } from "vitest";
import { InsertAgentSchema, UpdateAgentSchema } from "./agent";

describe("InsertAgentSchema", () => {
  describe("incomingEmailAllowedDomain validation", () => {
    it("accepts valid domain when internal mode and email enabled", () => {
      const result = InsertAgentSchema.safeParse({
        name: "Test Agent",
        teams: [],
        incomingEmailEnabled: true,
        incomingEmailSecurityMode: "internal",
        incomingEmailAllowedDomain: "company.com",
      });
      expect(result.success).toBe(true);
    });

    it("accepts subdomain when internal mode and email enabled", () => {
      const result = InsertAgentSchema.safeParse({
        name: "Test Agent",
        teams: [],
        incomingEmailEnabled: true,
        incomingEmailSecurityMode: "internal",
        incomingEmailAllowedDomain: "mail.company.com",
      });
      expect(result.success).toBe(true);
    });

    it("rejects missing domain when internal mode and email enabled", () => {
      const result = InsertAgentSchema.safeParse({
        name: "Test Agent",
        teams: [],
        incomingEmailEnabled: true,
        incomingEmailSecurityMode: "internal",
        incomingEmailAllowedDomain: "",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain(
          "Allowed domain is required",
        );
      }
    });

    it("rejects invalid domain format when internal mode and email enabled", () => {
      const result = InsertAgentSchema.safeParse({
        name: "Test Agent",
        teams: [],
        incomingEmailEnabled: true,
        incomingEmailSecurityMode: "internal",
        incomingEmailAllowedDomain: "not a domain",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("Invalid domain");
      }
    });

    it("rejects domain with protocol prefix", () => {
      const result = InsertAgentSchema.safeParse({
        name: "Test Agent",
        teams: [],
        incomingEmailEnabled: true,
        incomingEmailSecurityMode: "internal",
        incomingEmailAllowedDomain: "https://company.com",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("Invalid domain");
      }
    });

    it("rejects domain with trailing slash", () => {
      const result = InsertAgentSchema.safeParse({
        name: "Test Agent",
        teams: [],
        incomingEmailEnabled: true,
        incomingEmailSecurityMode: "internal",
        incomingEmailAllowedDomain: "company.com/",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("Invalid domain");
      }
    });

    it("allows empty domain when security mode is private", () => {
      const result = InsertAgentSchema.safeParse({
        name: "Test Agent",
        teams: [],
        incomingEmailEnabled: true,
        incomingEmailSecurityMode: "private",
        incomingEmailAllowedDomain: "",
      });
      expect(result.success).toBe(true);
    });

    it("allows empty domain when security mode is public", () => {
      const result = InsertAgentSchema.safeParse({
        name: "Test Agent",
        teams: [],
        incomingEmailEnabled: true,
        incomingEmailSecurityMode: "public",
        incomingEmailAllowedDomain: "",
      });
      expect(result.success).toBe(true);
    });

    it("allows empty domain when email is disabled", () => {
      const result = InsertAgentSchema.safeParse({
        name: "Test Agent",
        teams: [],
        incomingEmailEnabled: false,
        incomingEmailSecurityMode: "internal",
        incomingEmailAllowedDomain: "",
      });
      expect(result.success).toBe(true);
    });

    it("rejects domain exceeding max length", () => {
      const longDomain = `${"a".repeat(250)}.com`;
      const result = InsertAgentSchema.safeParse({
        name: "Test Agent",
        teams: [],
        incomingEmailEnabled: true,
        incomingEmailSecurityMode: "internal",
        incomingEmailAllowedDomain: longDomain,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("253 characters");
      }
    });
  });
});

describe("UpdateAgentSchema", () => {
  describe("incomingEmailAllowedDomain validation", () => {
    it("accepts valid domain when internal mode and email enabled", () => {
      const result = UpdateAgentSchema.safeParse({
        teams: [],
        incomingEmailEnabled: true,
        incomingEmailSecurityMode: "internal",
        incomingEmailAllowedDomain: "company.com",
      });
      expect(result.success).toBe(true);
    });

    it("rejects invalid domain when internal mode and email enabled", () => {
      const result = UpdateAgentSchema.safeParse({
        teams: [],
        incomingEmailEnabled: true,
        incomingEmailSecurityMode: "internal",
        incomingEmailAllowedDomain: "invalid domain",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("Invalid domain");
      }
    });

    it("allows partial updates without triggering validation", () => {
      const result = UpdateAgentSchema.safeParse({
        teams: [],
        name: "Updated Name",
      });
      expect(result.success).toBe(true);
    });

    it("allows updating email enabled without domain when mode is not internal", () => {
      const result = UpdateAgentSchema.safeParse({
        teams: [],
        incomingEmailEnabled: true,
        incomingEmailSecurityMode: "public",
      });
      expect(result.success).toBe(true);
    });
  });
});
