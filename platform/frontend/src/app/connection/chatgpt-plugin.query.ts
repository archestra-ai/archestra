import { archestraApiSdk } from "@archestra/shared";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { fetchAllSkills } from "@/lib/skills/skill.query";
import { throwOnApiError } from "@/lib/utils/api";
import {
  buildChatgptPlugin,
  validateChatgptGatewayUrl,
} from "./chatgpt-plugin";

export function useDownloadChatgptPlugin() {
  return useMutation({
    mutationFn: async (params: {
      appName: string;
      gatewayUrl: string;
      includeSkills: boolean;
    }) => {
      validateChatgptGatewayUrl(params.gatewayUrl);
      const skills = [];
      if (params.includeSkills) {
        const summaries = await fetchAllSkills(null, true);
        // Re-read each skill through its authorized detail endpoint at export time.
        for (const summary of summaries) {
          const { data, error } = await archestraApiSdk.getSkill({
            path: { id: summary.id },
          });
          throwOnApiError(error, { toastOnError: false });
          if (!data)
            throw new Error(
              "A skill is no longer available. Retry the download.",
            );
          skills.push(data);
        }
      }
      return buildChatgptPlugin({ ...params, skills });
    },
    onSuccess: ({ bytes, filename, skillCount, omitted }) => {
      const url = URL.createObjectURL(
        new Blob([bytes.slice().buffer], { type: "application/zip" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success(`Plugin downloaded with ${skillCount} skills.`);
      if (omitted.length)
        toast.info(
          `${omitted.length} templated or agent skills were left out because they require platform activation.`,
        );
    },
    onError: (error) => toast.error(error.message),
  });
}
