import { apiClient } from "@/lib/api/base";

export interface TokenPrice {
  id: string;
  provider: string;
  model: string;
  inputPricePer1M: string;
  outputPricePer1M: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateTokenPriceInput {
  id: string;
  inputPricePer1M: string;
  outputPricePer1M: string;
}

export const tokenPricingApi = {
  /**
   * Get all token prices, auto-creating for new models found in interactions
   */
  async getAll(): Promise<TokenPrice[]> {
    const response = await apiClient.get("/api/token-pricing");
    return response.data;
  },

  /**
   * Update multiple token prices
   */
  async updateMany(prices: UpdateTokenPriceInput[]): Promise<TokenPrice[]> {
    const response = await apiClient.put("/api/token-pricing", {
      prices,
    });
    return response.data;
  },
};