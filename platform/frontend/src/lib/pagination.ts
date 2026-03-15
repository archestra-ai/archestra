import type { archestraApiTypes } from "@shared";

type PaginationMeta =
  archestraApiTypes.GetMembersResponses["200"]["pagination"];

export function calculatePaginationMeta(params: {
  limit: number;
  offset: number;
  total: number;
}): PaginationMeta {
  const totalPages = Math.ceil(params.total / params.limit);
  const currentPage = Math.floor(params.offset / params.limit) + 1;

  return {
    currentPage,
    limit: params.limit,
    total: params.total,
    totalPages,
    hasNext: currentPage < totalPages,
    hasPrev: currentPage > 1,
  };
}
