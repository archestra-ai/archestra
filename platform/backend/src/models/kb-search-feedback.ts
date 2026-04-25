import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import db, { schema } from "@/database";

export type KbSearchFeedbackRating = "positive" | "negative";

export interface KbSearchFeedback {
  id: string;
  organizationId: string;
  knowledgeBaseId: string;
  documentId: string;
  chunkId: string | null;
  conversationId: string | null;
  userId: string;
  rating: KbSearchFeedbackRating;
  createdAt: Date;
}

export interface InsertKbSearchFeedback {
  organizationId: string;
  knowledgeBaseId: string;
  documentId: string;
  chunkId?: string | null;
  conversationId?: string | null;
  userId: string;
  rating: KbSearchFeedbackRating;
}

export interface KbSearchFeedbackStats {
  total: number;
  positiveCount: number;
  negativeCount: number;
  positivePercent: number;
  topDocuments: Array<{ documentId: string; title: string; positiveCount: number; negativeCount: number }>;
  bottomDocuments: Array<{ documentId: string; title: string; positiveCount: number; negativeCount: number }>;
}

export class KbSearchFeedbackModel {
  /** Submit a single feedback entry */
  static async create(data: InsertKbSearchFeedback): Promise<KbSearchFeedback> {
    const [result] = await db
      .insert(schema.kbSearchFeedbackTable)
      .values(data)
      .returning();
    return result;
  }

  /** Get aggregate stats for a knowledge base */
  static async getStats(knowledgeBaseId: string): Promise<KbSearchFeedbackStats> {
    const feedbacks = await db
      .select()
      .from(schema.kbSearchFeedbackTable)
      .where(eq(schema.kbSearchFeedbackTable.knowledgeBaseId, knowledgeBaseId));

    const total = feedbacks.length;
    const positiveCount = feedbacks.filter((f) => f.rating === "positive").length;
    const negativeCount = feedbacks.filter((f) => f.rating === "negative").length;
    const positivePercent = total > 0 ? Math.round((positiveCount / total) * 100) : 0;

    // Group by document
    const byDoc = new Map<string, { title: string; positiveCount: number; negativeCount: number; docId: string }>();
    for (const f of feedbacks) {
      if (!byDoc.has(f.documentId)) {
        // We'll populate title via a join below
        byDoc.set(f.documentId, { docId: f.documentId, title: "", positiveCount: 0, negativeCount: 0 });
      }
      const entry = byDoc.get(f.documentId)!;
      if (f.rating === "positive") entry.positiveCount++;
      else entry.negativeCount++;
    }

    // Fetch document titles
    if (byDoc.size > 0) {
      const docRows = await db
        .select({ id: schema.kbDocumentsTable.id, title: schema.kbDocumentsTable.title })
        .from(schema.kbDocumentsTable)
        .where(
          inArray(schema.kbDocumentsTable.id, Array.from(byDoc.keys()))
        );
      for (const row of docRows) {
        const entry = byDoc.get(row.id);
        if (entry) entry.title = row.title;
      }
    }

    const docs = Array.from(byDoc.values());
    docs.sort((a, b) => b.positiveCount - a.positiveCount);

    return {
      total,
      positiveCount,
      negativeCount,
      positivePercent,
      topDocuments: docs.slice(0, 5).map((d) => ({
        documentId: d.docId,
        title: d.title,
        positiveCount: d.positiveCount,
        negativeCount: d.negativeCount,
      })),
      bottomDocuments: docs.slice(-5).reverse().map((d) => ({
        documentId: d.docId,
        title: d.title,
        positiveCount: d.positiveCount,
        negativeCount: d.negativeCount,
      })),
    };
  }

  /** Delete feedback (owner or admin) */
  static async delete(id: string, userId: string): Promise<boolean> {
    const rows = await db
      .delete(schema.kbSearchFeedbackTable)
      .where(
        and(
          eq(schema.kbSearchFeedbackTable.id, id),
          eq(schema.kbSearchFeedbackTable.userId, userId),
        ),
      )
      .returning({ id: schema.kbSearchFeedbackTable.id });
    return rows.length > 0;
  }
}
