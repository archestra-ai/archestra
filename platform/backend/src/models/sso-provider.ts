import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { SsoProvider } from "@/types";

class SsoProviderModel {
  static async findAll(organizationId: string): Promise<SsoProvider[]> {
    const ssoProviders = await db
      .select()
      .from(schema.ssoProvidersTable)
      .where(eq(schema.ssoProvidersTable.organizationId, organizationId));
    return ssoProviders;
  }
}

export default SsoProviderModel;
