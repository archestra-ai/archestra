import { and, eq } from "drizzle-orm";
import { auth } from "@/auth/better-auth";
import db, { schema } from "@/database";
import type {
  InsertSsoProvider,
  PublicSsoProvider,
  SsoProvider,
  UpdateSsoProvider,
} from "@/types";

class SsoProviderModel {
  /**
   * Find all SSO providers with minimal public info only.
   * Use this for public/unauthenticated endpoints (e.g., login page SSO buttons).
   * Does NOT expose any sensitive configuration data.
   */
  static async findAllPublic(): Promise<PublicSsoProvider[]> {
    const ssoProviders = await db
      .select({
        id: schema.ssoProvidersTable.id,
        providerId: schema.ssoProvidersTable.providerId,
      })
      .from(schema.ssoProvidersTable);

    return ssoProviders;
  }

  /**
   * Find all SSO providers with full configuration including secrets.
   * Use this only for authenticated admin endpoints.
   * Filters by organizationId to enforce multi-tenant isolation.
   */
  static async findAll(organizationId: string): Promise<SsoProvider[]> {
    const ssoProviders = await db
      .select()
      .from(schema.ssoProvidersTable)
      .where(eq(schema.ssoProvidersTable.organizationId, organizationId));

    return ssoProviders.map((provider) => ({
      ...provider,
      oidcConfig: provider.oidcConfig
        ? JSON.parse(provider.oidcConfig as unknown as string)
        : undefined,
      samlConfig: provider.samlConfig
        ? JSON.parse(provider.samlConfig as unknown as string)
        : undefined,
    }));
  }

  static async findById(
    id: string,
    organizationId: string,
  ): Promise<SsoProvider | null> {
    const [ssoProvider] = await db
      .select()
      .from(schema.ssoProvidersTable)
      .where(
        and(
          eq(schema.ssoProvidersTable.id, id),
          eq(schema.ssoProvidersTable.organizationId, organizationId),
        ),
      );

    if (!ssoProvider) {
      return null;
    }

    return {
      ...ssoProvider,
      oidcConfig: ssoProvider.oidcConfig
        ? JSON.parse(ssoProvider.oidcConfig as unknown as string)
        : undefined,
      samlConfig: ssoProvider.samlConfig
        ? JSON.parse(ssoProvider.samlConfig as unknown as string)
        : undefined,
    };
  }

  static async create(
    data: Omit<InsertSsoProvider, "id">,
    organizationId: string,
    headers: HeadersInit,
  ): Promise<SsoProvider> {
    // Parse JSON configs if they exist
    const parsedData = {
      providerId: data.providerId,
      issuer: data.issuer,
      domain: data.domain,
      organizationId,
      ...(data.oidcConfig && {
        oidcConfig:
          typeof data.oidcConfig === "string"
            ? JSON.parse(data.oidcConfig)
            : data.oidcConfig,
      }),
      ...(data.samlConfig && {
        samlConfig:
          typeof data.samlConfig === "string"
            ? JSON.parse(data.samlConfig)
            : data.samlConfig,
      }),
    };

    // Ensure required mapping fields for OIDC
    if (parsedData.oidcConfig?.mapping) {
      parsedData.oidcConfig.mapping = {
        id: parsedData.oidcConfig.mapping.id || "sub",
        email: parsedData.oidcConfig.mapping.email || "email",
        name: parsedData.oidcConfig.mapping.name || "name",
        ...parsedData.oidcConfig.mapping,
      };
    }

    // Register with Better Auth
    await auth.api.registerSSOProvider({
      body: parsedData,
      headers: new Headers(headers),
    });

    // Better Auth automatically creates the database record, so we need to find it
    // The provider ID should be unique, so we can find by providerId and organizationId
    const createdProvider = await db
      .select()
      .from(schema.ssoProvidersTable)
      .where(
        and(
          eq(schema.ssoProvidersTable.providerId, data.providerId),
          eq(schema.ssoProvidersTable.organizationId, organizationId),
        ),
      );

    const [provider] = createdProvider;
    if (!provider) {
      throw new Error("Failed to create SSO provider");
    }

    return {
      ...provider,
      oidcConfig: provider.oidcConfig
        ? JSON.parse(provider.oidcConfig as unknown as string)
        : undefined,
      samlConfig: provider.samlConfig
        ? JSON.parse(provider.samlConfig as unknown as string)
        : undefined,
    };
  }

  static async update(
    id: string,
    data: Partial<UpdateSsoProvider>,
    organizationId: string,
  ): Promise<SsoProvider | null> {
    // First check if the provider exists
    const existingProvider = await SsoProviderModel.findById(
      id,
      organizationId,
    );
    if (!existingProvider) {
      return null;
    }

    // Update in database
    const [updatedProvider] = await db
      .update(schema.ssoProvidersTable)
      .set(data)
      .where(
        and(
          eq(schema.ssoProvidersTable.id, id),
          eq(schema.ssoProvidersTable.organizationId, organizationId),
        ),
      )
      .returning();

    if (!updatedProvider) return null;

    return {
      ...updatedProvider,
      oidcConfig: updatedProvider.oidcConfig
        ? JSON.parse(updatedProvider.oidcConfig as unknown as string)
        : undefined,
      samlConfig: updatedProvider.samlConfig
        ? JSON.parse(updatedProvider.samlConfig as unknown as string)
        : undefined,
    };
  }

  static async delete(id: string, organizationId: string): Promise<boolean> {
    // First check if the provider exists
    const existingProvider = await SsoProviderModel.findById(
      id,
      organizationId,
    );
    if (!existingProvider) {
      return false;
    }

    // Delete from database using returning() to verify deletion
    const deleted = await db
      .delete(schema.ssoProvidersTable)
      .where(
        and(
          eq(schema.ssoProvidersTable.id, id),
          eq(schema.ssoProvidersTable.organizationId, organizationId),
        ),
      )
      .returning({ id: schema.ssoProvidersTable.id });

    return deleted.length > 0;
  }
}

export default SsoProviderModel;
