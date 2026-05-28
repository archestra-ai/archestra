"use client";

import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError } from "@/lib/utils";

const {
  deleteConnectorDocument,
  getKnowledgeBaseDocuments,
  getConnectorDocument,
  getConnectorDocuments,
  getKnowledgeBaseDocument,
  deleteKnowledgeBaseDocument,
} = archestraApiSdk;

type ConnectorDocumentsQuery = NonNullable<
  archestraApiTypes.GetConnectorDocumentsData["query"]
>;

type KnowledgeBaseDocumentsQuery = NonNullable<
  archestraApiTypes.GetKnowledgeBaseDocumentsData["query"]
>;

export type KnowledgeBaseDocumentListItem =
  archestraApiTypes.GetConnectorDocumentsResponses["200"]["data"][number];

export type KnowledgeBaseDocumentDetail =
  archestraApiTypes.GetConnectorDocumentResponses["200"];

export function useConnectorDocuments(params: {
  connectorId: string;
  limit: number;
  offset: number;
  search?: string;
}) {
  return useQuery({
    queryKey: [
      "connector-documents",
      params.connectorId,
      params.limit,
      params.offset,
      params.search ?? "",
    ],
    placeholderData: (previousData) => previousData,
    queryFn: async () => {
      const query: ConnectorDocumentsQuery = {
        limit: params.limit,
        offset: params.offset,
        ...(params.search ? { search: params.search } : {}),
      };
      const { data, error } = await getConnectorDocuments({
        path: { id: params.connectorId },
        query,
      });
      if (error) {
        handleApiError(error);
        throw error;
      }
      return data;
    },
    enabled: !!params.connectorId,
  });
}

export function useConnectorDocument(params: {
  connectorId: string;
  docId: string;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: ["connector-document", params.connectorId, params.docId],
    queryFn: async () => {
      const { data, error } = await getConnectorDocument({
        path: { id: params.connectorId, docId: params.docId },
      });
      if (error) {
        handleApiError(error);
        throw error;
      }
      return data;
    },
    enabled:
      Boolean(params.connectorId) &&
      Boolean(params.docId) &&
      (params.enabled ?? true),
  });
}

export function useDeleteConnectorDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { connectorId: string; docId: string }) => {
      const { data, error } = await deleteConnectorDocument({
        path: {
          id: params.connectorId,
          docId: params.docId,
        },
      });
      if (error) {
        handleApiError(error);
        throw error;
      }
      return data;
    },
    onSuccess: (data, variables) => {
      if (!data) return;
      queryClient.invalidateQueries({
        queryKey: ["connector-documents", variables.connectorId],
      });
      queryClient.invalidateQueries({
        queryKey: ["connector-document", variables.connectorId],
      });
      queryClient.invalidateQueries({
        queryKey: ["connectors", variables.connectorId],
      });
      queryClient.invalidateQueries({ queryKey: ["connectors"] });
      toast.success("Document deleted successfully");
    },
  });
}

export function useKnowledgeBaseDocuments(params: {
  knowledgeBaseId: string;
  limit: number;
  offset: number;
  search?: string;
  connectorId?: string;
}) {
  return useQuery({
    queryKey: [
      "knowledge-base-documents",
      params.knowledgeBaseId,
      params.limit,
      params.offset,
      params.search ?? "",
      params.connectorId ?? "",
    ],
    placeholderData: (previousData) => previousData,
    queryFn: async () => {
      const query: KnowledgeBaseDocumentsQuery & { connectorId?: string } = {
        limit: params.limit,
        offset: params.offset,
        ...(params.search ? { search: params.search } : {}),
        ...(params.connectorId && params.connectorId !== "all"
          ? { connectorId: params.connectorId }
          : {}),
      };
      const { data, error } = await getKnowledgeBaseDocuments({
        path: { id: params.knowledgeBaseId },
        query,
      });
      if (error) {
        handleApiError(error);
        throw error;
      }
      return data;
    },
    enabled: !!params.knowledgeBaseId,
  });
}

export function useKnowledgeBaseDocument(params: {
  knowledgeBaseId: string;
  docId: string;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: ["knowledge-base-document", params.knowledgeBaseId, params.docId],
    queryFn: async () => {
      const { data, error } = await getKnowledgeBaseDocument({
        path: { id: params.knowledgeBaseId, docId: params.docId },
      });
      if (error) {
        handleApiError(error);
        throw error;
      }
      return data;
    },
    enabled:
      Boolean(params.knowledgeBaseId) &&
      Boolean(params.docId) &&
      (params.enabled ?? true),
  });
}

export function useDeleteKnowledgeBaseDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { knowledgeBaseId: string; docId: string }) => {
      const { data, error } = await deleteKnowledgeBaseDocument({
        path: {
          id: params.knowledgeBaseId,
          docId: params.docId,
        },
      });
      if (error) {
        handleApiError(error);
        throw error;
      }
      return data;
    },
    onSuccess: (data, variables) => {
      if (!data) return;
      queryClient.invalidateQueries({
        queryKey: ["knowledge-base-documents", variables.knowledgeBaseId],
      });
      queryClient.invalidateQueries({
        queryKey: ["knowledge-base-document", variables.knowledgeBaseId],
      });
      queryClient.invalidateQueries({ queryKey: ["knowledge-bases"] });
      toast.success("Document deleted successfully");
    },
  });
}
