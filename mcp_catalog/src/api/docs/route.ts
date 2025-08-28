import { NextResponse } from 'next/server';

import openApiSpec from '@mcpCatalog/api/docs/openapi.json';

export async function GET() {
  return NextResponse.json(openApiSpec);
}
