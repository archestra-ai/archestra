import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import config from "@/config";
import db, { schema } from "@/database";
import logger from "@/logging";

class User {
  static async createOrGetExistingDefaultAdminUser() {
    const email = config.auth.adminDefaultEmail;
    const password = config.auth.adminDefaultPassword;

    try {
      const existing = await db
        .select()
        .from(schema.usersTable)
        .where(eq(schema.usersTable.email, email));
      if (existing.length > 0) {
        logger.info({ email }, "Admin already exists:");
        return existing[0];
      }

      const result = await auth.api.signUpEmail({
        body: {
          email,
          password,
          name: "Admin",
        },
      });
      if (result) {
        await db
          .update(schema.usersTable)
          .set({
            role: "admin",
            emailVerified: true,
          })
          .where(eq(schema.usersTable.email, email));

        logger.info({ email }, "Admin user created successfully:");
      }
      return result.user;
    } catch (err) {
      logger.error({ err }, "Failed to create admin:");
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
