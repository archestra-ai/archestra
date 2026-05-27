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
    ): Promise<CreateSkillShareLinkResult | null> => {
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
      if (revokeError) {
        handleApiError(revokeError);
        // new link is live even if revoke failed; return it so the UI can show it
        return created ?? null;
      }
      return created ?? null;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["skill-share-links"] });
      toast.success("Share link updated");
    },
  });
}
