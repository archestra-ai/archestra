import { NextRequest, NextResponse } from 'next/server';

import { loadServers } from '@mcpCatalog/lib/catalog';
import { calculateQualityScore } from '@mcpCatalog/lib/quality-calculator';

export async function GET(request: NextRequest, props: { params: Promise<{ name: string }> }) {
  const params = await props.params;
  try {
    const { name } = params;

    if (!name) {
      return NextResponse.json({ error: 'Server name is required' }, { status: 400 });
    }

    // Load servers by name
    const servers = loadServers(name);
    const server = servers[0];

    if (!server) {
      return NextResponse.json({ error: 'Server not found' }, { status: 404 });
    }

    const {
      name: serverName,
      quality_score: qualityScore,
      github_info: { owner: gitHubInfoOwner, repo: gitHubInfoRepo, path: gitHubInfoPath },
    } = server;

    // Calculate trust score breakdown if score exists
    let scoreBreakdown = null;
    if (qualityScore !== null) {
      // Load all servers for dependency commonality calculation
      const allServers = loadServers();
      scoreBreakdown = calculateQualityScore(server, allServers);
    }

    // Return detailed server information
    return NextResponse.json({
      ...server,
      scoreBreakdown,
      // Add computed fields
      githubUrl: `https://github.com/${gitHubInfoOwner}/${gitHubInfoRepo}${gitHubInfoPath ? `/tree/main/${gitHubInfoPath}` : ''}`,
      badgeUrl: gitHubInfoPath
        ? `https://archestra.ai/mcp-catalog/api/badge/quality/${
            gitHubInfoOwner
          }/${gitHubInfoRepo}/${gitHubInfoPath.replace(/\//g, '--')}`
        : `https://archestra.ai/mcp-catalog/api/badge/quality/${gitHubInfoOwner}/${gitHubInfoRepo}`,
      detailPageUrl: `https://archestra.ai/mcp-catalog/${serverName}`,
    });
  } catch (error) {
    console.error('Server API error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
