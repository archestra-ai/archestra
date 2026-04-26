"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, toApiError } from "./utils";

export type MemoryScopeType = "user" | "team" | "org";

export interface AgentMemory {
  id: string;
  scopeType: MemoryScopeType;
  scopeId: string;
  organizationId: string;
  key: string;
  value: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertMemoryBody {
  scopeType: MemoryScopeType;
  scopeId: string;
  key: string;
  value: string;
}

async function fetchMemories(params?: {
  scopeType?: MemoryScopeType;
  scopeId?: string;
}): Promise<AgentMemory[]> {
  const url = new URL("/api/memories", window.location.origin);
  if (params?.scopeType) url.searchParams.set("scopeType", params.scopeType);
  if (params?.scopeId) url.searchParams.set("scopeId", params.scopeId);

  const res = await fetch(url.toString());
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err?.message ?? "Failed to fetch memories");
  }
  return res.json();
}

async function upsertMemory(body: UpsertMemoryBody): Promise<AgentMemory> {
  const res = await fetch("/api/memories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err?.message ?? "Failed to save memory");
  }
  return res.json();
}

async function deleteMemory(id: string): Promise<void> {
  const res = await fetch(`/api/memories/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err?.message ?? "Failed to delete memory");
  }
}

export function useAgentMemories(params?: {
  scopeType?: MemoryScopeType;
  scopeId?: string;
}) {
  return useQuery({
    queryKey: ["agent-memories", params],
    queryFn: () => fetchMemories(params),
  });
}

export function useUpsertAgentMemory() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: UpsertMemoryBody) => upsertMemory(body),
    onSuccess: () => {
      toast.success("Memory saved");
      queryClient.invalidateQueries({ queryKey: ["agent-memories"] });
    },
    onError: (error: Error) => {
      toast.error(error.message ?? "Failed to save memory");
    },
  });
}

export function useDeleteAgentMemory() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => deleteMemory(id),
    onSuccess: () => {
      toast.success("Memory deleted");
      queryClient.invalidateQueries({ queryKey: ["agent-memories"] });
    },
    onError: (error: Error) => {
      toast.error(error.message ?? "Failed to delete memory");
    },
  });
}
