import { HttpResponse, http } from "msw";
import config from "@/config";
import { indexFilesIntoKnowledgeBase } from "@/knowledge-base/file-upload/index-file";
import {
  KbChunkModel,
  KbDocumentModel,
  KbFileModel,
  KnowledgeBaseConnectorModel,
  OrganizationModel,
} from "@/models";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import type { AclEntry } from "@/types";
import type { TestFixtures } from "./fixtures";

/** Synthetic embeddings at the HTTP boundary; retrieval and ACL SQL stay real. */
export const knowledgeEmbeddingHandler = http.post(
  "https://embeddings.example.test/v1/embeddings",
  () =>
    HttpResponse.json({
      object: "list",
      data: [
        {
          object: "embedding",
          embedding: Buffer.from(new Float32Array(EMBEDDING).buffer).toString(
            "base64",
          ),
          index: 0,
        },
      ],
      model: "text-embedding-3-small",
      usage: { prompt_tokens: 1, total_tokens: 1 },
    }),
);

export async function configureKnowledgeSearch(
  organizationId: string,
  makeLlmProviderApiKey: TestFixtures["makeLlmProviderApiKey"],
) {
  const key = await makeLlmProviderApiKey(organizationId, null, {
    provider: "openai",
    baseUrl: "https://embeddings.example.test/v1",
  });
  await OrganizationModel.patch(organizationId, {
    embeddingChatApiKeyId: key.id,
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: EMBEDDING.length,
  });
  config.kb.hybridSearchEnabled = false;
  config.kb.contextExpansionRadius = 0;
  config.kb.contextualRetrievalEnabled = false;
}

export async function indexKnowledgeDocument(params: {
  organizationId: string;
  connectorId: string;
  content: string;
  acl: AclEntry[];
}) {
  const document = await KbDocumentModel.create({
    organizationId: params.organizationId,
    connectorId: params.connectorId,
    title: params.content,
    content: params.content,
    contentHash: crypto.randomUUID(),
    embeddingStatus: "completed",
  });
  await KbChunkModel.insertMany([
    {
      documentId: document.id,
      content: params.content,
      chunkIndex: 0,
      acl: params.acl,
    },
  ]);
  const [chunk] = await KbChunkModel.findByDocument(document.id);
  await KbChunkModel.updateEmbeddings(
    [{ chunkId: chunk.id, embedding: EMBEDDING }],
    EMBEDDING.length,
  );
  return document;
}

/** Exercise the real upload connector, file grant, document link and chunking path. */
export async function indexKnowledgeFile(params: {
  organizationId: string;
  knowledgeBaseId: string;
  uploadedBy: string;
  content: string;
  published: boolean;
}) {
  const data = Buffer.from(params.content);
  const file = await KbFileModel.create({
    organizationId: params.organizationId,
    uploadedBy: params.uploadedBy,
    directoryId: null,
    filename: `${crypto.randomUUID()}.txt`,
    mimeType: "text/plain",
    sizeBytes: data.length,
    contentHash: crypto.randomUUID(),
    data,
    initialPermissionGrants: params.published
      ? [
          {
            subject: { type: "organization", id: "*" },
            actions: ["read", "use"],
          },
        ]
      : [],
  });
  const result = await indexFilesIntoKnowledgeBase({
    organizationId: params.organizationId,
    knowledgeBaseId: params.knowledgeBaseId,
    fileIds: [file.id],
  });
  if (result.indexed !== 1) throw new Error(JSON.stringify(result.failures));
  const connectors = await KnowledgeBaseConnectorModel.findByKnowledgeBaseId(
    params.knowledgeBaseId,
    { canReadAll: true },
  );
  const connector = connectors.find(
    (candidate) => candidate.connectorType === "file_upload",
  );
  if (!connector) throw new Error("Upload connector was not created");
  const document = await KbDocumentModel.findBySourceId({
    connectorId: connector.id,
    sourceId: file.id,
  });
  if (!document) throw new Error("Upload document was not created");
  const chunks = await KbChunkModel.findByDocument(document.id);
  await KbChunkModel.updateEmbeddings(
    chunks.map((chunk) => ({ chunkId: chunk.id, embedding: EMBEDDING })),
    EMBEDDING.length,
  );
  return { file, connector, document };
}

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
/** Explicit Everyone grants, distinct from the role-based `access: "org"` fixture. */
export async function publishKnowledgeSource(params: {
  organizationId: string;
  resource: "knowledgeBase" | "knowledgeConnector" | "knowledgeFile";
  scope: string;
  readOnly?: boolean;
}) {
  const { readOnly, ...key } = params;
  await ResourcePermissionPolicyModel.replace({
    ...key,
    revision: (await ResourcePermissionPolicyModel.find(key))?.revision ?? 0,
    grants: [
      {
        subject: { type: "organization", id: "*" },
        actions: readOnly ? ["read"] : ["read", "use"],
      },
    ],
  });
}

// SPDX-SnippetEnd

const EMBEDDING = Array.from({ length: 1536 }, () => 0.01);
