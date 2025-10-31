import { archestraApiSdk, type archestraApiTypes } from "@shared";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";

const { getTokenPricing, updateTokenPricing } = archestraApiSdk;

export type TokenPrice = archestraApiTypes.GetTokenPricingResponses["200"][number];
export type UpdateTokenPriceInput = archestraApiTypes.UpdateTokenPricingData["body"]["prices"][number];

export function useTokenPrices() {
  return useQuery({
    queryKey: ["tokenPricing"],
    queryFn: async () => {
      try {
        const response = await getTokenPricing();
        return response.data ?? [];
      } catch (error) {
        console.error("Failed to fetch token prices:", error);
        toast.error("Failed to load token prices");
        return [];
      }
    },
  });
}

export function useUpdateTokenPrices() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (prices: UpdateTokenPriceInput[]) => {
      const response = await updateTokenPricing({
        body: { prices },
      });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tokenPricing"] });
      toast.success("Token prices updated successfully");
    },
    onError: (error: Error) => {
      console.error("Failed to update token prices:", error);
      toast.error(error.message || "Failed to update token prices");
    },
  });
}