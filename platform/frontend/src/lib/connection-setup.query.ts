import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { handleApiError } from "@/lib/utils";

const {
  createConnectionSetup,
  createConnectionVirtualKey,
  createConnectionPassthroughKey,
} = archestraApiSdk;

export type CreateConnectionSetupBody =
  archestraApiTypes.CreateConnectionSetupData["body"];
export type CreateConnectionSetupResult =
  archestraApiTypes.CreateConnectionSetupResponses["200"];
type CreateConnectionVirtualKeyBody =
  archestraApiTypes.CreateConnectionVirtualKeyData["body"];
type CreateConnectionPassthroughKeyBody =
  archestraApiTypes.CreateConnectionPassthroughKeyData["body"];

export function useCreateConnectionSetup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateConnectionSetupBody) => {
      const { data, error } = await createConnectionSetup({ body });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      // the setup may have provisioned a personal virtual key and, on script
      // fetch, will create a skill share link — keep those lists fresh.
      queryClient.invalidateQueries({ queryKey: ["virtual-api-keys"] });
      queryClient.invalidateQueries({ queryKey: ["skill-share-links"] });
    },
  });
}

/**
 * Provisions (or reuses) the caller's personal connection virtual key for a
 * provider and returns its value once — backs the manual /connection flow's
 * virtual-key option. Same auto-provisioning the one-command setup performs.
 */
export function useCreateConnectionVirtualKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateConnectionVirtualKeyBody) => {
      const { data, error } = await createConnectionVirtualKey({ body });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["virtual-api-keys"] });
    },
  });
}

/**
 * Provisions (or reuses) the caller's personal passthrough virtual key scoped
 * to an LLM proxy and returns its value once — backs the manual /connection
 * flow's X-Archestra-Virtual-Key attribution step (Claude Code, Claude Desktop).
 */
export function useCreateConnectionPassthroughKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateConnectionPassthroughKeyBody) => {
      const { data, error } = await createConnectionPassthroughKey({ body });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["virtual-api-keys"] });
    },
  });
}
