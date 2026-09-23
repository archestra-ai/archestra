import { calculatePaginationMeta } from "@archestra/shared";
import { ApiError } from "@/types";
import type {
  CoverageAgentsPage,
  CoverageAgentsQuery,
  CoverageServer,
  CoverageServersPage,
  CoverageServersQuery,
  CoverageSummary,
  CoverageToolsPage,
  CoverageToolsQuery,
} from "@/types/openappa-coverage";

/**
 * Which rule of the policy governs each installed tool, and what that makes
 * of every server and agent.
 *
 * Scaffold: every method answers an empty report until the coverage parse
 * lands (WP1). The routes and the frontend hooks are built against these
 * signatures.
 */
class OpenAppaCoverageService {
  async summary(_organizationId: string): Promise<CoverageSummary> {
    return {
      servers: 0,
      tools: 0,
      named: 0,
      unlisted: 0,
      agents: 0,
      agentsReachingOpen: 0,
      rootRevision: 0,
      effectiveHash: null,
      lastError: null,
    };
  }

  async servers(
    params: { organizationId: string } & CoverageServersQuery,
  ): Promise<CoverageServersPage> {
    return { data: [], pagination: calculatePaginationMeta(0, params) };
  }

  async server(_params: {
    organizationId: string;
    catalogId: string;
  }): Promise<CoverageServer> {
    throw new ApiError(404, "Catalog entry not found");
  }

  async tools(
    params: { organizationId: string } & CoverageToolsQuery,
  ): Promise<CoverageToolsPage> {
    return { data: [], pagination: calculatePaginationMeta(0, params) };
  }

  async agents(
    params: { organizationId: string } & CoverageAgentsQuery,
  ): Promise<CoverageAgentsPage> {
    return { data: [], pagination: calculatePaginationMeta(0, params) };
  }
}

export const openappaCoverageService = new OpenAppaCoverageService();
