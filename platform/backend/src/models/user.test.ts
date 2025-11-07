import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import db, { schema } from "@/database";
import User from "./user";
import OrganizationRoleModel from "./organization-role";

// Mock the database and models
vi.mock("@/database", () => ({
  default: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(),
  },
  schema: {
    member: {},
  },
}));

vi.mock("./organization-role", () => ({
  default: {
    getPermissions: vi.fn(),
  },
}));

describe("User", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getUserPermissions", () => {
    it("should return empty permissions when user is not a member", async () => {
      // Mock empty member record
      vi.mocked(db.limit).mockResolvedValue([]);

      const result = await User.getUserPermissions("user123", "org123");

      expect(result).toEqual({});
      expect(db.select).toHaveBeenCalled();
      expect(db.from).toHaveBeenCalledWith(schema.member);
      expect(db.where).toHaveBeenCalled();
      expect(db.limit).toHaveBeenCalledWith(1);
    });

    it("should return permissions for admin role", async () => {
      const mockMemberRecord = [
        {
          userId: "user123",
          organizationId: "org123",
          role: ADMIN_ROLE_NAME,
        },
      ];

      const mockPermissions = {
        "organization:read": ["read"],
        "organization:write": ["create", "update", "delete"],
        "agent:read": ["read"],
        "agent:write": ["create", "update", "delete"],
      };

      vi.mocked(db.limit).mockResolvedValue(mockMemberRecord);
      vi.mocked(OrganizationRoleModel.getPermissions).mockResolvedValue(mockPermissions);

      const result = await User.getUserPermissions("user123", "org123");

      expect(result).toEqual(mockPermissions);
      expect(OrganizationRoleModel.getPermissions).toHaveBeenCalledWith(
        ADMIN_ROLE_NAME,
        "org123"
      );
    });

    it("should return permissions for member role", async () => {
      const mockMemberRecord = [
        {
          userId: "user456",
          organizationId: "org456",
          role: MEMBER_ROLE_NAME,
        },
      ];

      const mockPermissions = {
        "agent:read": ["read"],
        "organization:read": ["read"],
      };

      vi.mocked(db.limit).mockResolvedValue(mockMemberRecord);
      vi.mocked(OrganizationRoleModel.getPermissions).mockResolvedValue(mockPermissions);

      const result = await User.getUserPermissions("user456", "org456");

      expect(result).toEqual(mockPermissions);
      expect(OrganizationRoleModel.getPermissions).toHaveBeenCalledWith(
        MEMBER_ROLE_NAME,
        "org456"
      );
    });

    it("should return permissions for custom role", async () => {
      const customRoleId = "custom-role-123";
      const mockMemberRecord = [
        {
          userId: "user789",
          organizationId: "org789",
          role: customRoleId,
        },
      ];

      const mockPermissions = {
        "agent:read": ["read"],
        "agent:write": ["create"],
      };

      vi.mocked(db.limit).mockResolvedValue(mockMemberRecord);
      vi.mocked(OrganizationRoleModel.getPermissions).mockResolvedValue(mockPermissions);

      const result = await User.getUserPermissions("user789", "org789");

      expect(result).toEqual(mockPermissions);
      expect(OrganizationRoleModel.getPermissions).toHaveBeenCalledWith(
        customRoleId,
        "org789"
      );
    });

    it("should handle multiple member records and return first", async () => {
      const mockMemberRecords = [
        {
          userId: "user123",
          organizationId: "org123",
          role: ADMIN_ROLE_NAME,
        },
        {
          userId: "user123",
          organizationId: "org123",
          role: MEMBER_ROLE_NAME,
        },
      ];

      const mockPermissions = {
        "organization:read": ["read"],
        "organization:write": ["create", "update", "delete"],
      };

      vi.mocked(db.limit).mockResolvedValue(mockMemberRecords);
      vi.mocked(OrganizationRoleModel.getPermissions).mockResolvedValue(mockPermissions);

      const result = await User.getUserPermissions("user123", "org123");

      expect(result).toEqual(mockPermissions);
      // Should use the first record's role
      expect(OrganizationRoleModel.getPermissions).toHaveBeenCalledWith(
        ADMIN_ROLE_NAME,
        "org123"
      );
    });

    it("should handle database query errors gracefully", async () => {
      vi.mocked(db.limit).mockRejectedValue(new Error("Database error"));

      await expect(User.getUserPermissions("user123", "org123")).rejects.toThrow(
        "Database error"
      );

      expect(db.select).toHaveBeenCalled();
      expect(OrganizationRoleModel.getPermissions).not.toHaveBeenCalled();
    });

    it("should handle OrganizationRoleModel.getPermissions errors", async () => {
      const mockMemberRecord = [
        {
          userId: "user123",
          organizationId: "org123",
          role: ADMIN_ROLE_NAME,
        },
      ];

      vi.mocked(db.limit).mockResolvedValue(mockMemberRecord);
      vi.mocked(OrganizationRoleModel.getPermissions).mockRejectedValue(
        new Error("Permission error")
      );

      await expect(User.getUserPermissions("user123", "org123")).rejects.toThrow(
        "Permission error"
      );

      expect(OrganizationRoleModel.getPermissions).toHaveBeenCalledWith(
        ADMIN_ROLE_NAME,
        "org123"
      );
    });
  });
});