import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError } from "@/lib/utils";

const { getSkillShareLinks, createSkillShareLink, revokeSkillShareLink } =
  archestraApiSdk;

export type SkillShareLink =
  archestraApiTypes.GetSkillShareLinksResponses["200"]["links"][number];
export type CreateSkillShareLinkBody =
  archestraApiTypes.CreateSkillShareLinkData["body"];
export type CreateSkillShareLinkResult =
  archestraApiTypes.CreateSkillShareLinkResponses["200"];

export function useListSkillShareLinks(skillId?: string | null) {
  return useQuery({
    queryKey: ["skill-share-links", { skillId: skillId ?? null }],
    queryFn: async () => {
      const { data, error } = await getSkillShareLinks({
        query: skillId ? { skillId } : undefined,
      });
      if (error) {
        handleApiError(error);
        return { links: [] as SkillShareLink[] };
      }
      return data;
    },
  });
}

export function useCreateSkillShareLink() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateSkillShareLinkBody) => {
      const { data, error } = await createSkillShareLink({ body });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["skill-share-links"] });
      toast.success("Share link created");
    },
  });
}

export function useRevokeSkillShareLink() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await revokeSkillShareLink({ path: { id } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["skill-share-links"] });
      toast.success("Share link revoked");
    },
  });
}

export interface RotateSkillShareLinkVars {
  previousLinkId: string;
  body: CreateSkillShareLinkBody;
}

export interface RotateSkillShareLinkOutput {
  created: CreateSkillShareLinkResult | null;
  revokeFailed: boolean;
  revokeError: unknown;
}

/**
 * Rotates a share link as one operation: create the new link, then revoke
 * the old one. Only invoke from an explicit user action — rotation kills
 * every URL already distributed for the previous link.
 */
export function useRotateSkillShareLink() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      vars: RotateSkillShareLinkVars,
    ): Promise<RotateSkillShareLinkOutput | null> => {
      const { data: created, error: createError } = await createSkillShareLink({
        body: vars.body,
      });
      if (createError) {
        handleApiError(createError);
        return null;
      }
      const { error: revokeError } = await revokeSkillShareLink({
        path: { id: vars.previousLinkId },
      });
      return {
        created: created ?? null,
        revokeFailed: Boolean(revokeError),
        revokeError,
      };
    },
    onSuccess: (result) => {
      if (!result?.created) return;
      queryClient.invalidateQueries({ queryKey: ["skill-share-links"] });
      if (result.revokeFailed) {
        if (result.revokeError) handleApiError(result.revokeError);
        // the new link is live but the old one is still valid — surface the
        // partial state so the admin knows to revoke manually.
        toast.error(
          "New share link created, but revoking the previous one failed. The old URL still works.",
        );
        return;
      }
      toast.success("Share link updated");
    },
  });
}
