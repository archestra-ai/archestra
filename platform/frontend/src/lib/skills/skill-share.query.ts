import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError } from "@/lib/utils";

const {
  getSkillShareLinks,
  createSkillShareLink,
  revokeSkillShareLink,
  rotateSkillShareLink,
} = archestraApiSdk;

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
 * Rotates a share link: the backend revokes the old link and creates its
 * replacement in one transaction. Only invoke from an explicit user action —
 * rotation kills every URL already distributed for the previous link.
 */
export function useRotateSkillShareLink() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      vars: RotateSkillShareLinkVars,
    ): Promise<CreateSkillShareLinkResult | null> => {
      const { data, error } = await rotateSkillShareLink({
        path: { id: vars.previousLinkId },
        body: vars.body,
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["skill-share-links"] });
      toast.success("Share link updated");
    },
  });
}
