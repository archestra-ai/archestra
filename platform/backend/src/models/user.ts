import { eq } from "drizzle-orm";
import { auth } from "@/auth/auth";
import config from "@/config";
import db, { schema } from "@/database";

class User {
  static async createAdminUser() {
    const email = config.auth.adminDefaultEmail;
    const password = config.auth.adminDefaultPassword;

    try {
      const existing = await db
        .select()
        .from(schema.usersTable)
        .where(eq(schema.usersTable.email, email));
      if (existing.length > 0) {
        console.log("Admin already exists:", email);
        return;
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

        console.log("Admin user created successfully:", email);
      }
    } catch (err) {
      console.error("Failed to create admin:", err);
    }
  }
}

export default User;
