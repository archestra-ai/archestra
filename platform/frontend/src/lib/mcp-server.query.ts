import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import {
  type GetMcpServersResponses,
  getMcpServers,
  type InstallMcpServerData,
  installMcpServer,
} from "@/lib/clients/api";

export function useMcpServers(params?: {
  initialData?: GetMcpServersResponses["200"];
}) {
  return useSuspenseQuery({
    queryKey: ["mcp-servers"],
    queryFn: async () => (await getMcpServers()).data ?? [],
    initialData: params?.initialData,
  });
}

export function useInstallMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: InstallMcpServerData["body"]) => {
      const response = await installMcpServer({ body: data });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
    },
  });
}
