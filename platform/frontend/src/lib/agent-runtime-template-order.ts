import type { PopularAgentOverrides } from "@archestra/shared";

/** Explicit saved positions precede unpositioned choices, which retain catalog order. */
export function runtimeTemplatePosition(
  id: string,
  custom: readonly { id: string; position: number }[],
  overrides: PopularAgentOverrides | null | undefined,
) {
  return (
    custom.find((item) => item.id === id)?.position ??
    overrides?.[id as keyof PopularAgentOverrides]?.position ??
    Number.MAX_SAFE_INTEGER
  );
}
