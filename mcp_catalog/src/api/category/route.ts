import { NextResponse } from 'next/server';

import { McpServerCategorySchema } from '@mcpCatalog/schemas';

export async function GET() {
  const categories = McpServerCategorySchema.options;

  return NextResponse.json({ categories });
}
