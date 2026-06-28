import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { KbDocumentModel, KbChunkModel, KnowledgeBaseConnectorModel } from "@/models";
import { AclMaterializer } from "./acl-materializer";
import { IdentityResolutionService } from "./identity-resolution";

export async function recomputeConnectorPermissions(connectorId: string): Promise<void> {
  const connector = await KnowledgeBaseConnectorModel.findById(connectorId);
  if (!connector || connector.visibility !== "auto-sync-permissions") {
    return;
  }

  const documents = await KbDocumentModel.findAllByConnector(connectorId);
  const materializer = new AclMaterializer(new IdentityResolutionService(connector.organizationId));

  for (const doc of documents) {
    if (doc.permissionSyncStatus === null) {
      continue;
    }

    const metadata = doc.permissionSyncMetadata as any;
    if (!metadata || !metadata.rawPermissions) {
      continue;
    }

    const resolved = await materializer.materialize(metadata.rawPermissions);
    const currentAcl = doc.acl || [];

    const aclChanged =
      currentAcl.length !== resolved.acl.length ||
      !currentAcl.every((val, index) => val === resolved.acl[index]);

    const statusChanged = doc.permissionSyncStatus !== (resolved.complete ? "synced" : "skipped_unresolvable");

    if (aclChanged || statusChanged) {
      const nextStatus = resolved.complete ? "synced" : "skipped_unresolvable";
      const nextMetadata = {
        ...metadata,
        resolvedEmails: resolved.resolvedEmails,
        skippedGroups: resolved.skippedGroups,
        lastSyncedAt: new Date().toISOString(),
      };

      // Update document ACL and permission status/metadata
      await KbDocumentModel.update(doc.id, {
        acl: resolved.complete ? resolved.acl : [],
        permissionSyncStatus: nextStatus,
        permissionSyncMetadata: nextMetadata,
      });

      // Update matching chunks
      await KbChunkModel.updateAclByDocument(doc.id, resolved.complete ? resolved.acl : []);
    }
  }
}

export async function handleTeamOrGroupMappingChange(organizationId: string): Promise<void> {
  // Find all connectors for the organization
  const connectors = await db
    .select()
    .from(schema.knowledgeBaseConnectorsTable)
    .where(eq(schema.knowledgeBaseConnectorsTable.organizationId, organizationId));

  const targetConnectors = connectors.filter(c => c.visibility === "auto-sync-permissions");

  for (const connector of targetConnectors) {
    await recomputeConnectorPermissions(connector.id);
  }
}
