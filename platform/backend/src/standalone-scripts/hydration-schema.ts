import { isDeepStrictEqual } from "node:util";

/** Copying encrypted values requires identical storage schemas on both sides. */
export async function assertMatchingHydrationSchemas(params: {
  source: SchemaReader;
  target: SchemaReader;
}): Promise<void> {
  const query = `SELECT table_name, column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position`;
  const [source, target] = await Promise.all([
    params.source.query(query),
    params.target.query(query),
  ]);
  if (!source.rows.length || !isDeepStrictEqual(source.rows, target.rows)) {
    throw new Error(
      "Source and target database schemas must match before hydration. No data was copied.",
    );
  }
}

type SchemaReader = {
  query: (query: string) => Promise<{ rows: unknown[] }>;
};
