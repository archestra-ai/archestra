"use client";

import type { ConnectorType } from "@archestra/shared";
import { DocumentOcrNotice } from "@/app/knowledge/_parts/document-ocr-notice";
import { useSession } from "@/lib/auth/auth.query";
import { useOrganization } from "@/lib/organization.query";

/**
 * Connectors whose sync reads PDFs through the OCR-capable extractor (the
 * ones that pass the run's OCR context into `extractPdfText`). Other sources
 * carry no scanned pages, so the note would be noise there.
 */
const PDF_CAPABLE_CONNECTOR_TYPES = new Set<ConnectorType>([
  "dropbox",
  "gdrive",
  "mfiles",
  "onedrive",
  "sharepoint",
]);

export function ConnectorDocumentOcrNotice({
  connectorType,
}: {
  connectorType: ConnectorType;
}) {
  if (!PDF_CAPABLE_CONNECTOR_TYPES.has(connectorType)) return null;
  return <CurrentDocumentOcrNotice />;
}

function CurrentDocumentOcrNotice() {
  const { data: organization } = useOrganization();
  const { data: session } = useSession();

  const dismissalScope =
    organization?.id && session?.user.id
      ? `${organization.id}:${session.user.id}`
      : null;
  if (!organization || !dismissalScope) return null;

  return (
    <DocumentOcrNotice
      ocrConfigured={!!organization.ocrChatApiKeyId && !!organization.ocrModel}
      dismissalScope={dismissalScope}
    />
  );
}
