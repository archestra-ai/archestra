// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type { ScopedResource } from "@archestra/shared";
import { sql } from "drizzle-orm";
import db from "@/database";
import ResourcePermissionPolicyModel from "./resource-permission-policy";

/** Authoritative read check: does a grant give this user read on the object? */
export default class ResourcePermissionAccessModel {
  static async canRead(params: {
    organizationId: string;
    userId: string;
    resource: ScopedResource;
    scope: string;
    includeWildcard?: boolean;
  }): Promise<boolean> {
    const result = await db.execute<{ allowed: boolean }>(
      sql`SELECT ${ResourcePermissionPolicyModel.grantCondition({
        ...params,
        scopeColumn: sql`${params.scope}::text`,
        action: "read",
      })} AS allowed`,
    );
    return result.rows[0]?.allowed ?? false;
  }
}
