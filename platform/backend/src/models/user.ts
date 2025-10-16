import { DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD } from "@shared";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import db from "@/database";
import { user } from "@/database/schemas";

class User {
  static async createAdminUser() {
    const email = process.env.BETTER_AUTH_ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL;
    const password =
      process.env.BETTER_AUTH_ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;

    if (!email || !password) {
      console.warn(
        "BETTER_AUTH_ADMIN_EMAIL or BETTER_AUTH_ADMIN_PASSWORD not set. Skipping admin creation.",
      );
      return;
    }

    try {
      const existing = await db
        .select()
        .from(user)
        .where(eq(user.email, email));
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
          .update(user)
          .set({
            role: "admin",
            emailVerified: true,
          })
          .where(eq(user.email, email));

        console.log("Admin user created successfully:", email);
      }
    } catch (err) {
      console.error("Failed to create admin:", err);
    }
  }
}

export default User;
