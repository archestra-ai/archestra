import type { Role } from "@shared";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import config from "@/config";
import db, { schema } from "@/database";
import logger from "@/logging";

class User {
  static async createOrGetExistingDefaultAdminUser({
    email = config.auth.adminDefaultEmail,
    password = config.auth.adminDefaultPassword,
    role = "admin",
    name = "Admin",
  }: {
    email?: string;
    password?: string;
    role?: Role;
    name?: string;
  } = {}) {
    try {
      const existing = await db
        .select()
        .from(schema.usersTable)
        .where(eq(schema.usersTable.email, email));
      if (existing.length > 0) {
        logger.info({ email }, "User already exists:");
        return existing[0];
      }

      const result = await auth.api.signUpEmail({
        body: {
          email,
          password,
          name,
        },
      });
      if (result) {
        await db
          .update(schema.usersTable)
          .set({
            role,
            emailVerified: true,
          })
          .where(eq(schema.usersTable.email, email));

        logger.info({ email }, "User created successfully:");
      }
      return result.user;
    } catch (err) {
      logger.error({ err }, "Failed to create user");
    }
  }

  static async getUserById(id: string) {
    const [user] = await db
      .select()
      .from(schema.usersTable)
      .where(eq(schema.usersTable.id, id))
      .limit(1);
    return user;
  }
}

export default User;
