import { NextRequest, NextResponse } from 'next/server';

import { SearchQuerySchema, SearchResponseSchema } from '@mcpCatalog/api/schemas';
import { loadServers } from '@mcpCatalog/lib/catalog';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;

    // Parse and validate query parameters
    const validationResult = SearchQuerySchema.safeParse({
      q: searchParams.get('q') || undefined,
      category: searchParams.get('category') || undefined,
      language: searchParams.get('language') || undefined,
      limit: searchParams.get('limit') || undefined,
      offset: searchParams.get('offset') || undefined,
      sortBy: searchParams.get('sortBy') || undefined,
    });

    if (!validationResult.success) {
      return NextResponse.json(
        { error: 'Invalid query parameters', details: validationResult.error.errors },
        { status: 400 }
      );
    }

    const {
      q: query = '',
      category = '',
      language = '',
      limit = 20,
      offset = 0,
      sortBy = 'quality',
    } = validationResult.data;

    // Load all servers
    const allServers = loadServers();

    // Filter servers
    let filteredServers = allServers.filter(
      ({
        name,
        description,
        github_info: { owner, repo },
        category: serverCategory,
        programming_language: programmingLanguage,
      }) => {
        // Search query filter
        if (query) {
          const searchQuery = query.toLowerCase();
          const matchesSearch =
            name.toLowerCase().includes(searchQuery) ||
            description.toLowerCase().includes(searchQuery) ||
            owner.toLowerCase().includes(searchQuery) ||
            repo.toLowerCase().includes(searchQuery);

          if (!matchesSearch) return false;
        }

        // Category filter
        if (category && serverCategory !== category) {
          return false;
        }

        // Language filter
        if (language && programmingLanguage !== language) {
          return false;
        }

        return true;
      }
    );

    // Sort servers
    filteredServers.sort((a, b) => {
      switch (sortBy) {
        case 'quality':
          // Sort by trust score (descending), null values last
          if (a.quality_score === null && b.quality_score === null) return 0;
          if (a.quality_score === null) return 1;
          if (b.quality_score === null) return -1;
          return b.quality_score - a.quality_score;

        case 'stars':
          // Sort by GitHub stars (descending)
          return (b.github_info.stars || 0) - (a.github_info.stars || 0);

        case 'name':
          // Sort alphabetically by name
          return a.name.localeCompare(b.name);

        default:
          return 0;
      }
    });

    // Apply pagination
    const totalCount = filteredServers.length;
    const paginatedServers = filteredServers.slice(offset, offset + limit);

    // Validate response data
    const responseData = SearchResponseSchema.parse({
      servers: paginatedServers,
      totalCount,
      limit,
      offset,
      hasMore: offset + limit < totalCount,
    });

    return NextResponse.json(responseData);
  } catch (error) {
    console.error('Search API error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
