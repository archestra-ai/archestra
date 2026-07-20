import type { ArchestraMcpServerManifest, ArchestraScoreBreakdown, MCPDependency } from '@mcpCatalog/types';

/**
 * Calculate MCP Protocol Implementation Score (40 points max)
 * Based on implementing various MCP protocol features
 * If not evaluated yet, give 35 points (partial credit)
 */
export function calculateMCPProtocolScore({ protocol_features }: ArchestraMcpServerManifest): number {
  // If protocol features haven't been analyzed yet or is undefined, give partial points
  if (!protocol_features || Object.keys(protocol_features).length === 0) {
    return 35;
  }

  let score = 0;

  const {
    implementing_tools,
    implementing_resources,
    implementing_prompts,
    implementing_sampling,
    implementing_stdio,
    implementing_streamable_http,
    implementing_roots,
    implementing_logging,
    implementing_oauth2,
  } = protocol_features;

  // Core features (most important) - 8 points each
  if (implementing_tools) score += 8;
  if (implementing_resources) score += 8;

  // Secondary features - 5 points each
  if (implementing_prompts) score += 5;
  if (implementing_sampling) score += 5;

  // Transport features - 4 points each (at least one required)
  if (implementing_stdio) score += 4;
  if (implementing_streamable_http) score += 4;

  // Additional features - 3 points each
  if (implementing_roots) score += 3;
  if (implementing_logging) score += 3;

  // Authentication - 2 points
  if (implementing_oauth2) score += 2;

  return Math.min(score, 40);
}

/**
 * Calculate GitHub Metrics Score (20 points max)
 * Progressive scoring: higher stars, contributors, and issues = higher score
 * For multi-server repositories, metrics are divided by the number of servers
 */
export function calculateGitHubMetricsScore(
  server: ArchestraMcpServerManifest,
  allServers?: ArchestraMcpServerManifest[]
): number {
  // Remote servers don't have GitHub metrics
  if (!server.github_info) {
    return 0;
  }

  const {
    owner: serverGitHubOwner,
    repo: serverGitHubRepo,
    stars: serverGitHubStars,
    contributors: serverGitHubContributors,
    issues: serverGitHubIssues,
  } = server.github_info;

  let score = 0;

  // Check if this is a multi-server repository
  let serverCount = 1;
  if (allServers) {
    serverCount = allServers.filter(
      (s) => s.github_info && s.github_info.owner === serverGitHubOwner && s.github_info.repo === serverGitHubRepo
    ).length;
    serverCount = Math.max(1, serverCount);
  }

  // Divide metrics by server count for multi-server repos
  const adjustedStars = serverGitHubStars / serverCount;
  const adjustedContributors = serverGitHubContributors / serverCount;
  const adjustedIssues = serverGitHubIssues / serverCount;

  // Stars scoring (0-10 points)
  // 0-10 stars: 0 points, 11-50: 2 points, 51-100: 4 points, 101-500: 6 points, 501-1000: 8 points, >1000: 10 points
  if (adjustedStars > 1000) score += 10;
  else if (adjustedStars > 500) score += 8;
  else if (adjustedStars > 100) score += 6;
  else if (adjustedStars > 50) score += 4;
  else if (adjustedStars > 10) score += 2;

  // Contributors scoring (0-6 points)
  // 1 contributor: 0 points, 2-3: 2 points, 4-10: 4 points, >10: 6 points
  if (adjustedContributors > 10) score += 6;
  else if (adjustedContributors >= 4) score += 4;
  else if (adjustedContributors >= 2) score += 2;

  // Issues scoring (0-4 points)
  // 0-5 issues: 0 points, 6-20: 2 points, >20: 4 points
  if (adjustedIssues > 20) score += 4;
  else if (adjustedIssues > 5) score += 2;

  return Math.min(score, 20);
}

/**
 * Calculate Deployment Maturity Score (10 points max)
 * Based on CI/CD, versioning, and release practices
 */
export function calculateDeploymentMaturityScore(server: ArchestraMcpServerManifest): number {
  // Remote servers don't have GitHub deployment info
  if (!server.github_info) {
    return 0;
  }

  const { ci_cd, releases } = server.github_info;
  let score = 0;

  // Check for CI/CD (GitHub Actions, etc.) - 5 points
  if (ci_cd) {
    score += 5;
  }

  // Check for releases - 5 points
  if (releases) {
    score += 5;
  }

  return Math.min(score, 10);
}

/**
 * Calculate Documentation Score (8 points max)
 * Based on basic documentation completeness
 */
export function calculateDocumentationScore({ readme }: ArchestraMcpServerManifest): number {
  let score = 0;

  // Extended documentation - has readme
  if (readme && readme.length > 100) {
    score += 8;
  }

  return Math.min(score, 8);
}

/**
 * Calculate Badge Usage Score (2 points max)
 * 2 points for using our badge in README.md
 * Note: This would require checking the actual README content from GitHub
 */
export function calculateBadgeUsageScore({ readme }: ArchestraMcpServerManifest): number {
  if (!readme) {
    return 0;
  }

  // Check for any Archestra mention in the README
  return readme.toLowerCase().includes('archestra') ? 2 : 0;
}

/**
 * Calculate Dependencies Score (20 points max)
 * Based on dependency count and rarity of dependencies
 */
export function calculateDependenciesScore(
  { dependencies }: ArchestraMcpServerManifest,
  allServers?: ArchestraMcpServerManifest[]
): number {
  // If dependencies haven't been analyzed yet, give partial points
  if (!dependencies) {
    return 15;
  }

  // If dependencies array is empty (no dependencies), that's ideal - return full points
  if (dependencies.length === 0) {
    return 20;
  }

  // Start with full points
  let score = 20;

  // Count significant dependencies (importance >= 5)
  const significantDeps = dependencies.filter((dep: MCPDependency) => dep.importance >= 5);
  const depCount = significantDeps.length;

  // Penalty only if more than 10 dependencies
  if (depCount > 10) {
    // Lose 1 point for each dependency over 10, up to 10 points
    const penalty = Math.min(10, depCount - 10);
    score -= penalty;
  }

  // Additional penalty for using rare dependencies
  if (allServers && allServers.length > 10) {
    // Build frequency map of all dependencies
    const depFrequency = new Map<string, number>();
    for (const otherServer of allServers) {
      if (otherServer.dependencies) {
        for (const dep of otherServer.dependencies.filter((d: MCPDependency) => d.importance >= 5)) {
          depFrequency.set(dep.name, (depFrequency.get(dep.name) || 0) + 1);
        }
      }
    }

    // Check for rare dependencies (used by fewer than 5 servers)
    let rareDependencyPenalty = 0;
    for (const dep of significantDeps) {
      const frequency = depFrequency.get(dep.name) || 0;
      if (frequency < 5) {
        // Each rare dependency reduces score by 2 points
        rareDependencyPenalty += 2;
      }
    }

    // Apply penalty for rare dependencies (up to 10 points)
    score -= Math.min(10, rareDependencyPenalty);
  }

  return Math.max(0, Math.min(20, score));
}

/**
 * Calculate total trust score with breakdown
 */
export function calculateQualityScore(
  server: ArchestraMcpServerManifest,
  allServers?: ArchestraMcpServerManifest[]
): ArchestraScoreBreakdown {
  // Remote servers get a fixed high score of 80
  if (server.server.type === 'remote') {
    return {
      mcp_protocol: 0,
      github_metrics: 0,
      deployment_maturity: 0,
      documentation: 0,
      dependencies: 0,
      badge_usage: 0,
      total: 80,
    };
  }

  const mcpProtocol = calculateMCPProtocolScore(server);
  const githubMetrics = calculateGitHubMetricsScore(server, allServers);
  const deploymentMaturity = calculateDeploymentMaturityScore(server);
  const documentation = calculateDocumentationScore(server);
  const dependencies = calculateDependenciesScore(server, allServers);
  const badgeUsage = calculateBadgeUsageScore(server);

  return {
    mcp_protocol: mcpProtocol,
    github_metrics: githubMetrics,
    deployment_maturity: deploymentMaturity,
    documentation: documentation,
    dependencies: dependencies,
    badge_usage: badgeUsage,
    total: mcpProtocol + githubMetrics + deploymentMaturity + documentation + dependencies + badgeUsage,
  };
}
