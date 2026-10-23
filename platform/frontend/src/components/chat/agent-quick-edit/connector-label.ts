import type { archestraApiTypes } from "@archestra/shared";
import { getConnectorTypeLabel } from "@/app/knowledge/knowledge-bases/_parts/connector-dialog-config";

type ConnectorType =
  archestraApiTypes.GetConnectorsResponses["200"]["data"][number]["connectorType"];

/** A connector type's display name, including uploads, which have no dialog. */
export function connectorLabel(type: ConnectorType): string {
  return type === "file_upload" ? "File upload" : getConnectorTypeLabel(type);
}
