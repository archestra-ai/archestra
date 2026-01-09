/**
 * @deprecated LEGACY ADAPTER - Used only by LLM Proxy v1 routes and metrics
 */

/** Returns input and output usage tokens from Cohere V2 response */
export function getUsageTokens(usage: any) {
    const billed = usage?.billed_units;
    const tokens = usage?.tokens;
    return {
        input: billed?.input_tokens ?? tokens?.input_tokens ?? 0,
        output: billed?.output_tokens ?? tokens?.output_tokens ?? 0,
    };
}
