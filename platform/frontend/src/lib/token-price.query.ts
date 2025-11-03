import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

const {
  getTokenPrices,
  createTokenPrice,
  getTokenPrice,
  updateTokenPrice,
  deleteTokenPrice,
} = archestraApiSdk;

export function useTokenPrices() {
  return useQuery({
    queryKey: ["tokenPrices"],
    queryFn: async () => {
      const response = await getTokenPrices();
      return response.data ?? [];
    },
  });
}

export function useTokenPrice(id: string) {
  return useQuery({
    queryKey: ["tokenPrices", id],
    queryFn: async () => {
      const response = await getTokenPrice({ path: { id } });
      return response.data;
    },
    enabled: !!id,
  });
}

export function useCreateTokenPrice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      data: archestraApiTypes.CreateTokenPriceData["body"],
    ) => {
      const response = await createTokenPrice({ body: data });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tokenPrices"] });
      toast.success("Token price created successfully");
    },
    onError: (error) => {
      console.error("Create token price error:", error);
      toast.error("Failed to create token price");
    },
  });
}

export function useUpdateTokenPrice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...data
    }: { id: string } & Partial<
      archestraApiTypes.UpdateTokenPriceData["body"]
    >) => {
      const response = await updateTokenPrice({
        path: { id },
        body: data,
      });
      return response.data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["tokenPrices"] });
      queryClient.invalidateQueries({
        queryKey: ["tokenPrices", variables.id],
      });
      toast.success("Token price updated successfully");
    },
    onError: (error) => {
      console.error("Update token price error:", error);
      toast.error("Failed to update token price");
    },
  });
}

export function useDeleteTokenPrice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      const response = await deleteTokenPrice({ path: { id } });
      return response.data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["tokenPrices"] });
      queryClient.removeQueries({ queryKey: ["tokenPrices", variables.id] });
      toast.success("Token price deleted successfully");
    },
    onError: (error) => {
      console.error("Delete token price error:", error);
      toast.error("Failed to delete token price");
    },
  });
}
