"use client";

import { Loader2, MessageSquare, Send } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import {
  type BatchAnalysisDetail,
  useAskBatchAnalysis,
} from "@/lib/batch-analysis/batch-analysis.query";

type Row = BatchAnalysisDetail["rows"][number];
type Column = BatchAnalysisDetail["analysis"]["columns"][number];

interface Exchange {
  question: string;
  answer: string;
  references: { rowId: string; columnKey: string }[];
}

/**
 * One-shot Q&A over the extracted grid. Deliberately not a persisted
 * conversation: each question is answered against the current table, and the
 * exchanges live only as long as the panel — the durable artifact is the grid
 * itself. Reference chips jump to the cited cell.
 */
export function AskGridPanel({
  analysisId,
  open,
  onOpenChange,
  rows,
  columns,
  onReference,
}: {
  analysisId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: Row[];
  columns: Column[];
  onReference: (rowId: string, columnKey: string) => void;
}) {
  const ask = useAskBatchAnalysis(analysisId);
  const [question, setQuestion] = useState("");
  const [exchanges, setExchanges] = useState<Exchange[]>([]);

  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const columnsByKey = new Map(columns.map((column) => [column.key, column]));

  const submit = () => {
    const trimmed = question.trim();
    if (!trimmed || ask.isPending) return;
    ask.mutate(trimmed, {
      onSuccess: (result) => {
        if (!result) return;
        setExchanges((prev) => [
          ...prev,
          {
            question: trimmed,
            answer: result.answer,
            references: result.references,
          },
        ]);
        setQuestion("");
      },
    });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-lg">
        <SheetHeader className="shrink-0 border-b px-6 py-4">
          <SheetTitle className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4" />
            <span>Ask the grid</span>
          </SheetTitle>
          <SheetDescription>
            Questions are answered from the extracted answers — not the source
            documents — and cite the cells they relied on.
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
          {exchanges.length === 0 && !ask.isPending && (
            <p className="text-muted-foreground text-sm">
              Try “which agreements renew automatically?” or “where is the
              highest liability cap?”.
            </p>
          )}
          {exchanges.map((exchange, index) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only session list
              key={index}
              className="space-y-1.5"
            >
              <p className="font-medium text-sm">{exchange.question}</p>
              <p className="whitespace-pre-wrap text-sm leading-relaxed">
                {exchange.answer}
              </p>
              {exchange.references.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {exchange.references.map((reference) => {
                    const row = rowsById.get(reference.rowId);
                    const column = columnsByKey.get(reference.columnKey);
                    if (!row || !column) return null;
                    return (
                      <button
                        key={`${reference.rowId}:${reference.columnKey}`}
                        type="button"
                        className="rounded-full border px-2 py-0.5 text-muted-foreground text-xs transition-colors hover:bg-accent hover:text-foreground"
                        onClick={() =>
                          onReference(reference.rowId, reference.columnKey)
                        }
                      >
                        {row.label} · {column.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
          {ask.isPending && (
            <p className="flex items-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>Reading the grid…</span>
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-end gap-2 border-t px-6 py-3">
          <Textarea
            rows={2}
            value={question}
            placeholder="Ask about the answers in this grid…"
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <Button
            size="icon"
            aria-label="Ask"
            disabled={!question.trim() || ask.isPending}
            onClick={submit}
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
