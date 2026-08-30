import { z } from "zod";
import { retrievalEvaluationService } from "@/services/retrieval-evaluation";

const PayloadSchema = z.object({ runId: z.string().uuid() });

export async function handleRetrievalEvaluation(
  payload: Record<string, unknown>,
): Promise<void> {
  const { runId } = PayloadSchema.parse(payload);
  await retrievalEvaluationService.executeRun(runId);
}
