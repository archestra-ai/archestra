"use client";

import { archestraApiSdk } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { handleApiError } from "./utils";

export interface UserMemory {
  id: string;
  userId: string;
  organizationId: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

const QUERY_KEY = ["userMemories"] as const;

export function useUserMemories() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getUserMemories();
      if (error) {
        handleApiError(error);
        return [] as UserMemory[];
      }
      return data as UserMemory[];
    },
  });
}

export function useCreateUserMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { title: string; content: string }) => {
      const { data, error } = await archestraApiSdk.createUserMemory({
        body: input,
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data as UserMemory;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
}

export function useUpdateUserMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      title?: string;
      content?: string;
    }) => {
      const { id, ...body } = input;
      const { data, error } = await archestraApiSdk.updateUserMemory({
        path: { id },
        body,
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data as UserMemory;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
}

export function useDeleteUserMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await archestraApiSdk.deleteUserMemory({
        path: { id },
      });
      if (error) {
        handleApiError(error);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
}
