# Backend Pagination Implementation Guide

This guide explains how to implement pagination in the Archestra platform backend using the reusable pagination utilities.

## Table of Contents

- [Overview](#overview)
- [Core Concepts](#core-concepts)
- [Quick Start](#quick-start)
- [API Reference](#api-reference)
- [Implementation Guide](#implementation-guide)
- [Best Practices](#best-practices)
- [Examples](#examples)

## Overview

The pagination system provides:
- **Type-safe** pagination with Zod schemas
- **Reusable utilities** for consistent pagination across all routes
- **Efficient database queries** with offset-based pagination
- **Rich metadata** including page counts, navigation flags, and totals

### Key Files

```
backend/src/
├── types/api.ts                    # Pagination types and schemas
├── database/utils/
│   └── pagination.ts              # Pagination utility functions
├── models/
│   └── interaction.ts             # Example: Model with pagination
└── routes/
    └── interaction.ts             # Example: Route with pagination
```

## Core Concepts

### 1. Query Parameters

Users pass pagination parameters as query strings:

```typescript
// From @/types/api.ts
PaginationQuerySchema = {
  limit: number   // Items per page (default: 20, max: 100)
  offset: number  // Starting position (default: 0)
}
```

**Example:** `GET /api/interactions?limit=50&offset=100`

### 2. Response Structure

All paginated endpoints return this structure:

```typescript
{
  data: T[],           // Array of items
  pagination: {
    currentPage: number,   // Current page (1-indexed)
    limit: number,         // Items per page
    total: number,         // Total items in dataset
    totalPages: number,    // Total number of pages
    hasNext: boolean,      // Can go to next page
    hasPrev: boolean       // Can go to previous page
  }
}
```

### 3. Offset vs Page Number

- **Backend uses**: `offset` (0-based, direct database offset)
- **Frontend shows**: `page` (1-indexed, user-friendly)
- **Conversion**: `offset = (page - 1) * limit`

## Quick Start

### Step 1: Add Pagination to Your Model

```typescript
import { count } from "drizzle-orm";
import db, { schema } from "@/database";
import type { PaginationQuery } from "@/types";
import { createPaginatedResult } from "@/database/utils/pagination";

class YourModel {
  static async findAllPaginated(
    pagination: PaginationQuery,
  ): Promise<PaginatedResult<YourType>> {
    // Run both queries in parallel for performance
    const [data, [{ total }]] = await Promise.all([
      db
        .select()
        .from(schema.yourTable)
        .orderBy(desc(schema.yourTable.createdAt))
        .limit(pagination.limit)
        .offset(pagination.offset),
      db
        .select({ total: count() })
        .from(schema.yourTable),
    ]);

    return createPaginatedResult(data, Number(total), pagination);
  }
}
```

### Step 2: Add Pagination to Your Route

```typescript
import { z } from "zod";
import {
  PaginationQuerySchema,
  createPaginatedResponseSchema,
  SelectYourSchema,
} from "@/types";

fastify.get(
  "/api/your-endpoint",
  {
    schema: {
      operationId: "getYourItems",
      description: "Get items with pagination",
      tags: ["YourTag"],
      querystring: PaginationQuerySchema,
      response: {
        200: createPaginatedResponseSchema(SelectYourSchema),
      },
    },
  },
  async ({ query: { limit, offset } }, reply) => {
    const result = await YourModel.findAllPaginated({ limit, offset });
    return reply.send(result);
  },
);
```

### Step 3: Test Your Endpoint

```bash
# Default pagination (20 items, page 1)
curl http://localhost:9000/api/your-endpoint

# Custom pagination (50 items, starting at offset 100)
curl http://localhost:9000/api/your-endpoint?limit=50&offset=100

# Page 3 with 20 items per page (offset = 40)
curl http://localhost:9000/api/your-endpoint?limit=20&offset=40
```

## API Reference

### Types (from `@/types`)

#### `PaginationQuerySchema`

Zod schema for validating pagination query parameters.

```typescript
const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

type PaginationQuery = z.infer<typeof PaginationQuerySchema>;
```

#### `PaginationMetaSchema`

Zod schema for pagination metadata in responses.

```typescript
const PaginationMetaSchema = z.object({
  currentPage: z.number().int().min(1),
  limit: z.number().int().min(1),
  total: z.number().int().min(0),
  totalPages: z.number().int().min(0),
  hasNext: z.boolean(),
  hasPrev: z.boolean(),
});

type PaginationMeta = z.infer<typeof PaginationMetaSchema>;
```

#### `createPaginatedResponseSchema(itemSchema)`

Factory function to create a paginated response schema for any item type.

```typescript
function createPaginatedResponseSchema<T extends z.ZodTypeAny>(
  itemSchema: T,
) {
  return z.object({
    data: z.array(itemSchema),
    pagination: PaginationMetaSchema,
  });
}
```

### Utilities (from `@/database/utils/pagination`)

#### `createPaginatedResult<T>(data, total, params)`

Creates a paginated result with metadata.

**Parameters:**
- `data: T[]` - The paginated data array
- `total: number` - Total number of items in the dataset
- `params: PaginationQuery` - The pagination parameters used

**Returns:** `PaginatedResult<T>`

```typescript
interface PaginatedResult<T> {
  data: T[];
  pagination: PaginationMeta;
}
```

**Example:**
```typescript
const [data, [{ total }]] = await Promise.all([
  db.select().from(table).limit(20).offset(0),
  db.select({ total: count() }).from(table),
]);

return createPaginatedResult(data, Number(total), { limit: 20, offset: 0 });
```

#### `calculatePaginationMeta(total, params)`

Calculates pagination metadata without data.

**Parameters:**
- `total: number` - Total number of items
- `params: PaginationQuery` - Pagination parameters

**Returns:** `PaginationMeta`

**Example:**
```typescript
const meta = calculatePaginationMeta(100, { limit: 20, offset: 40 });
// { currentPage: 3, limit: 20, total: 100, totalPages: 5, hasNext: true, hasPrev: true }
```

#### `applyPagination<T>(queryBuilder, params)`

Applies limit and offset to a Drizzle query builder.

**Parameters:**
- `queryBuilder: PgSelect` - Drizzle query builder
- `params: PaginationQuery` - Pagination parameters

**Returns:** Modified query builder

**Example:**
```typescript
const query = db.select().from(table);
const paginatedQuery = applyPagination(query, { limit: 20, offset: 0 });
const results = await paginatedQuery;
```

## Implementation Guide

### Adding Pagination with Filters

When you need to filter results, apply the same WHERE clause to both queries:

```typescript
static async findAllPaginated(
  pagination: PaginationQuery,
  filters?: { agentId?: string; status?: string },
): Promise<PaginatedResult<YourType>> {
  // Build WHERE conditions
  const conditions: SQL[] = [];
  
  if (filters?.agentId) {
    conditions.push(eq(schema.yourTable.agentId, filters.agentId));
  }
  
  if (filters?.status) {
    conditions.push(eq(schema.yourTable.status, filters.status));
  }
  
  const whereCondition = conditions.length > 0 
    ? and(...conditions) 
    : undefined;

  // Apply same WHERE to both queries
  const [data, [{ total }]] = await Promise.all([
    db
      .select()
      .from(schema.yourTable)
      .where(whereCondition)
      .orderBy(desc(schema.yourTable.createdAt))
      .limit(pagination.limit)
      .offset(pagination.offset),
    db
      .select({ total: count() })
      .from(schema.yourTable)
      .where(whereCondition),
  ]);

  return createPaginatedResult(data, Number(total), pagination);
}
```

### Route with Filters and Pagination

```typescript
fastify.get(
  "/api/your-endpoint",
  {
    schema: {
      operationId: "getYourItems",
      querystring: z.object({
        agentId: z.string().uuid().optional(),
        status: z.enum(["active", "inactive"]).optional(),
      }).merge(PaginationQuerySchema),
      response: {
        200: createPaginatedResponseSchema(SelectYourSchema),
      },
    },
  },
  async ({ query: { limit, offset, agentId, status } }, reply) => {
    const result = await YourModel.findAllPaginated(
      { limit, offset },
      { agentId, status },
    );
    return reply.send(result);
  },
);
```

### Adding Sorting to Pagination

Extend pagination with sorting capabilities:

```typescript
// Define sort options
interface SortOptions {
  sortBy?: "createdAt" | "name" | "status";
  sortDirection?: "asc" | "desc";
}

static async findAllPaginated(
  pagination: PaginationQuery,
  sort: SortOptions = { sortBy: "createdAt", sortDirection: "desc" },
): Promise<PaginatedResult<YourType>> {
  // Build order clause
  const orderColumn = sort.sortBy === "name" 
    ? schema.yourTable.name
    : sort.sortBy === "status"
    ? schema.yourTable.status
    : schema.yourTable.createdAt;
  
  const orderFn = sort.sortDirection === "asc" ? asc : desc;

  const [data, [{ total }]] = await Promise.all([
    db
      .select()
      .from(schema.yourTable)
      .orderBy(orderFn(orderColumn))
      .limit(pagination.limit)
      .offset(pagination.offset),
    db.select({ total: count() }).from(schema.yourTable),
  ]);

  return createPaginatedResult(data, Number(total), pagination);
}
```

Route with sorting:

```typescript
fastify.get(
  "/api/your-endpoint",
  {
    schema: {
      querystring: z.object({
        sortBy: z.enum(["createdAt", "name", "status"]).optional(),
        sortDirection: z.enum(["asc", "desc"]).default("desc"),
      }).merge(PaginationQuerySchema),
      response: {
        200: createPaginatedResponseSchema(SelectYourSchema),
      },
    },
  },
  async ({ query: { limit, offset, sortBy, sortDirection } }, reply) => {
    const result = await YourModel.findAllPaginated(
      { limit, offset },
      { sortBy, sortDirection },
    );
    return reply.send(result);
  },
);
```

### Adding Pagination to Existing Methods

Keep your old non-paginated methods for backward compatibility:

```typescript
class YourModel {
  // Old method - keep for backward compatibility
  static async findAll(): Promise<YourType[]> {
    return db
      .select()
      .from(schema.yourTable)
      .orderBy(desc(schema.yourTable.createdAt));
  }

  // New paginated method
  static async findAllPaginated(
    pagination: PaginationQuery,
  ): Promise<PaginatedResult<YourType>> {
    const [data, [{ total }]] = await Promise.all([
      db
        .select()
        .from(schema.yourTable)
        .orderBy(desc(schema.yourTable.createdAt))
        .limit(pagination.limit)
        .offset(pagination.offset),
      db.select({ total: count() }).from(schema.yourTable),
    ]);

    return createPaginatedResult(data, Number(total), pagination);
  }
}
```

## Best Practices

### 1. Always Run Queries in Parallel

✅ **Good:** Use `Promise.all()` for better performance

```typescript
const [data, [{ total }]] = await Promise.all([
  dataQuery,
  countQuery,
]);
```

❌ **Bad:** Sequential queries are slower

```typescript
const data = await dataQuery;
const [{ total }] = await countQuery;
```

### 2. Apply Same WHERE Conditions

✅ **Good:** Same conditions for both queries

```typescript
const whereCondition = eq(table.status, "active");

const [data, [{ total }]] = await Promise.all([
  db.select().from(table).where(whereCondition).limit(20).offset(0),
  db.select({ total: count() }).from(table).where(whereCondition),
]);
```

❌ **Bad:** Different conditions give wrong totals

```typescript
const [data, [{ total }]] = await Promise.all([
  db.select().from(table).where(eq(table.status, "active")).limit(20),
  db.select({ total: count() }).from(table), // Missing WHERE!
]);
```

### 3. Use Consistent Ordering

Always specify an `ORDER BY` clause for predictable pagination:

```typescript
.orderBy(desc(schema.yourTable.createdAt))  // Most recent first
```

### 4. Validate Pagination Parameters

The schema enforces limits automatically:
- Minimum limit: 1
- Maximum limit: 100 (prevents performance issues)
- Minimum offset: 0

### 5. Add Appropriate Database Indexes

Create indexes on columns used in WHERE and ORDER BY:

```sql
-- For filtering by agentId
CREATE INDEX idx_interactions_agent_id ON interactions(agent_id);

-- For ordering by createdAt
CREATE INDEX idx_interactions_created_at ON interactions(created_at DESC);
```

## Examples

### Example 1: Basic Pagination

See `backend/src/models/interaction.ts` and `backend/src/routes/interaction.ts`

```typescript
// Model
class InteractionModel {
  static async findAllPaginated(
    pagination: PaginationQuery,
  ): Promise<PaginatedResult<Interaction>> {
    const [data, [{ total }]] = await Promise.all([
      db
        .select()
        .from(schema.interactionsTable)
        .orderBy(desc(schema.interactionsTable.createdAt))
        .limit(pagination.limit)
        .offset(pagination.offset),
      db.select({ total: count() }).from(schema.interactionsTable),
    ]);

    return createPaginatedResult(data, Number(total), pagination);
  }
}

// Route
fastify.get(
  "/api/interactions",
  {
    schema: {
      querystring: PaginationQuerySchema,
      response: {
        200: createPaginatedResponseSchema(SelectInteractionSchema),
      },
    },
  },
  async ({ query: { limit, offset } }, reply) => {
    const result = await InteractionModel.findAllPaginated({ limit, offset });
    return reply.send(result);
  },
);
```

### Example 2: Pagination with Sorting

See `backend/src/models/interaction.ts` for a real implementation with sorting:

```typescript
static async findAllPaginated(
  pagination: PaginationQuery,
  sort: { sortBy?: "createdAt" | "model" | "agentId"; sortDirection?: "asc" | "desc" } = {},
): Promise<PaginatedResult<Interaction>> {
  const { sortBy = "createdAt", sortDirection = "desc" } = sort;
  
  // Map sortBy to actual column
  const orderColumn = sortBy === "model"
    ? schema.interactionsTable.model
    : sortBy === "agentId"
    ? schema.interactionsTable.agentId
    : schema.interactionsTable.createdAt;
  
  const orderFn = sortDirection === "asc" ? asc : desc;

  const [data, [{ total }]] = await Promise.all([
    db
      .select()
      .from(schema.interactionsTable)
      .orderBy(orderFn(orderColumn))
      .limit(pagination.limit)
      .offset(pagination.offset),
    db.select({ total: count() }).from(schema.interactionsTable),
  ]);

  return createPaginatedResult(data, Number(total), pagination);
}
```

### Example 3: Pagination with Filtering

```typescript
// Model with agentId filter
static async getAllInteractionsForProfilePaginated(
  agentId: string,
  pagination: PaginationQuery,
): Promise<PaginatedResult<Interaction>> {
  const whereCondition = eq(schema.interactionsTable.agentId, agentId);

  const [data, [{ total }]] = await Promise.all([
    db
      .select()
      .from(schema.interactionsTable)
      .where(whereCondition)
      .orderBy(asc(schema.interactionsTable.createdAt))
      .limit(pagination.limit)
      .offset(pagination.offset),
    db
      .select({ total: count() })
      .from(schema.interactionsTable)
      .where(whereCondition),
  ]);

  return createPaginatedResult(data, Number(total), pagination);
}

// Route
fastify.get(
  "/api/interactions",
  {
    schema: {
      querystring: z.object({
        agentId: z.string().uuid().optional(),
      }).merge(PaginationQuerySchema),
      response: {
        200: createPaginatedResponseSchema(SelectInteractionSchema),
      },
    },
  },
  async ({ query: { agentId, limit, offset } }, reply) => {
    if (agentId) {
      const result = await InteractionModel.getAllInteractionsForProfilePaginated(
        agentId,
        { limit, offset },
      );
      return reply.send(result);
    }

    const result = await InteractionModel.findAllPaginated({ limit, offset });
    return reply.send(result);
  },
);
```

### Example 4: Complex Filters

```typescript
interface TaskFilters {
  status?: "pending" | "completed" | "failed";
  assignedTo?: string;
  createdAfter?: Date;
}

static async findTasksPaginated(
  pagination: PaginationQuery,
  filters: TaskFilters = {},
): Promise<PaginatedResult<Task>> {
  const conditions: SQL[] = [];

  if (filters.status) {
    conditions.push(eq(schema.tasks.status, filters.status));
  }

  if (filters.assignedTo) {
    conditions.push(eq(schema.tasks.assignedTo, filters.assignedTo));
  }

  if (filters.createdAfter) {
    conditions.push(gte(schema.tasks.createdAt, filters.createdAfter));
  }

  const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

  const [data, [{ total }]] = await Promise.all([
    db
      .select()
      .from(schema.tasks)
      .where(whereCondition)
      .orderBy(desc(schema.tasks.createdAt))
      .limit(pagination.limit)
      .offset(pagination.offset),
    db
      .select({ total: count() })
      .from(schema.tasks)
      .where(whereCondition),
  ]);

  return createPaginatedResult(data, Number(total), pagination);
}
```

## Troubleshooting

### Issue: Wrong Total Count

**Problem:** The total count doesn't match filtered results.

**Solution:** Ensure both queries use the same WHERE conditions:

```typescript
const whereCondition = eq(table.status, "active");

const [data, [{ total }]] = await Promise.all([
  db.select().from(table).where(whereCondition).limit(20),
  db.select({ total: count() }).from(table).where(whereCondition), // ✅ Same WHERE
]);
```

### Issue: Performance Problems

**Problem:** Pagination is slow for large offsets.

**Solution:** 
1. Add database indexes on columns used in WHERE and ORDER BY
2. Consider cursor-based pagination for very large datasets (future enhancement)

### Issue: Incorrect Page Numbers

**Problem:** `currentPage` calculation is wrong.

**Cause:** The calculation uses `Math.floor(offset / limit) + 1`.

**Example:**
- `offset=0, limit=20` → page 1 ✅
- `offset=20, limit=20` → page 2 ✅
- `offset=40, limit=20` → page 3 ✅

## Migration Checklist

When adding pagination to an existing endpoint:

- [ ] Create `findAllPaginated()` method in model
- [ ] Keep old `findAll()` method for backward compatibility
- [ ] Update route schema to include `PaginationQuerySchema`
- [ ] Update response schema with `createPaginatedResponseSchema()`
- [ ] Update route handler to use pagination parameters
- [ ] Add database indexes if needed
- [ ] Update frontend to handle paginated responses
- [ ] Test with various page sizes and offsets
- [ ] Update API documentation

