import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

const { getTokenPricing, updateTokenPricing } = archestraApiSdk;

export type TokenPrice =
  archestraApiTypes.GetTokenPricingResponses["200"][number];
export type UpdateTokenPriceInput =
  archestraApiTypes.UpdateTokenPricingData["body"]["prices"][number];

export function useTokenPrices() {
  return useQuery({
    queryKey: ["tokenPricing"],
    queryFn: async () => {
      try {
        const response = await getTokenPricing();
        return response.data ?? [];
      } catch (error) {
        console.error("Failed to fetch token prices - Full error:", error);
        if (error instanceof Error) {
          console.error("Error message:", error.message);
          console.error("Error stack:", error.stack);
        }
        // Check if it's a 403 error (forbidden)
        if (
          (error as any)?.response?.status === 403 ||
          (error as any)?.status === 403
        ) {
          toast.error("You need admin privileges to manage token prices");
        } else {
          toast.error("Failed to load token prices");
        }
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
