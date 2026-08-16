// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

"use client";

import { useEffect, useState } from "react";
import { Table as TableIcon } from "lucide-react";
import { CreateDocReviewModal } from "@/components/knowledge/create-doc-review-modal.ee";
import { DocReviewGrid, type DocReviewGridData } from "@/components/knowledge/doc-review-grid.ee";
import { KnowledgePageLayout } from "@/app/knowledge/_parts/knowledge-page-layout";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

export default function DocumentReviewsPage() {
  const [reviews, setReviews] = useState<any[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<any[]>([]);
  const [activeReviewId, setActiveReviewId] = useState<string | null>(null);
  const [activeGridData, setActiveGridData] = useState<DocReviewGridData | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchReviews = async () => {
    try {
      const res = await fetch("/api/doc-reviews");
      if (res.ok) {
        const data = await res.json();
        setReviews(data.reviews ?? []);
      }
    } catch {
      setReviews([]);
    } finally {
      setLoading(false);
    }
  };

  const fetchKnowledgeBases = async () => {
    try {
      const res = await fetch("/api/knowledge-bases");
      if (res.ok) {
        const data = await res.json();
        setKnowledgeBases(data.knowledgeBases ?? []);
      }
    } catch {
      setKnowledgeBases([]);
    }
  };

  const fetchGridData = async (reviewId: string) => {
    try {
      const res = await fetch(`/api/doc-reviews/${reviewId}/grid`);
      if (res.ok) {
        const data = await res.json();
        setActiveGridData(data);
      }
    } catch {
      setActiveGridData(null);
    }
  };

  useEffect(() => {
    fetchReviews();
    fetchKnowledgeBases();
  }, []);

  useEffect(() => {
    if (activeReviewId) {
      fetchGridData(activeReviewId);
      // Auto-poll grid data every 4s if running
      const interval = setInterval(() => {
        fetchGridData(activeReviewId);
      }, 4000);
      return () => clearInterval(interval);
    }
  }, [activeReviewId]);

  const handleCreateReview = async (params: any) => {
    const res = await fetch("/api/doc-reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });

    if (res.ok) {
      const data = await res.json();
      await fetchReviews();
      setActiveReviewId(data.review.id);
    }
  };

  const handleResumeRun = async (reviewId: string) => {
    await fetch(`/api/doc-reviews/${reviewId}/resume`, { method: "POST" });
    if (activeReviewId === reviewId) {
      fetchGridData(reviewId);
    }
    fetchReviews();
  };

  const handleRetryCell = async (cellId: string) => {
    if (!activeReviewId) return;
    await fetch(`/api/doc-reviews/${activeReviewId}/cells/${cellId}/retry`, {
      method: "POST",
    });
    fetchGridData(activeReviewId);
  };

  return (
    <KnowledgePageLayout
      title="Document Reviews"
      description="Execute structured question sets across documents in bulk and inspect tabular matrix results."
      createLabel="New Review Table"
      onCreateClick={() => setIsModalOpen(true)}
      isPending={loading}
    >
      {activeReviewId && activeGridData ? (
        <div className="space-y-4">
          <button
            onClick={() => {
              setActiveReviewId(null);
              setActiveGridData(null);
            }}
            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 font-medium"
          >
            ← Back to Review Tables List
          </button>
          <DocReviewGrid
            data={activeGridData}
            onRefresh={() => fetchGridData(activeReviewId)}
            onResume={() => handleResumeRun(activeReviewId)}
            onRetryCell={handleRetryCell}
          />
        </div>
      ) : (
        <div className="space-y-6">
          {reviews.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center justify-center py-12 text-center space-y-3">
                <div className="p-3 bg-muted rounded-full">
                  <TableIcon className="h-6 w-6 text-muted-foreground" />
                </div>
                <div className="space-y-1">
                  <h3 className="text-base font-semibold">No Document Reviews Yet</h3>
                  <p className="text-sm text-muted-foreground max-w-sm">
                    Create a review table to extract structured fields across hundreds of documents simultaneously.
                  </p>
                </div>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {reviews.map((rev) => {
                const percent = rev.totalCells > 0
                  ? Math.round((rev.completedCells / rev.totalCells) * 100)
                  : 0;

                return (
                  <Card
                    key={rev.id}
                    className="hover:border-primary/50 transition-colors cursor-pointer"
                    onClick={() => setActiveReviewId(rev.id)}
                  >
                    <CardContent className="p-5 space-y-3">
                      <div className="flex justify-between items-start gap-2">
                        <h4 className="font-semibold text-base line-clamp-1">{rev.name}</h4>
                        <span className="text-[11px] uppercase font-semibold px-2 py-0.5 rounded bg-muted">
                          {rev.status}
                        </span>
                      </div>
                      {rev.description && (
                        <p className="text-xs text-muted-foreground line-clamp-2">
                          {rev.description}
                        </p>
                      )}
                      <div className="space-y-1 pt-2">
                        <div className="flex justify-between text-xs text-muted-foreground">
                          <span>Progress</span>
                          <span>{rev.completedCells} / {rev.totalCells} cells</span>
                        </div>
                        <Progress value={percent} className="h-1.5" />
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      )}

      <CreateDocReviewModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        knowledgeBases={knowledgeBases}
        onSubmit={handleCreateReview}
      />
    </KnowledgePageLayout>
  );
}
