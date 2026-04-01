import { Fingerprint, Star, Zap } from "lucide-react";
import { InlineTag } from "@/components/ui/inline-tag";

export function UnknownCapabilitiesBadge() {
  return (
    <InlineTag className="text-muted-foreground bg-muted">
      capabilities unknown
    </InlineTag>
  );
}

export function FastestModelBadge() {
  return (
    <InlineTag
      icon={<Zap />}
      className="text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-950"
    >
      fastest
    </InlineTag>
  );
}

export function BestModelBadge() {
  return (
    <InlineTag
      icon={<Star />}
      className="text-purple-700 dark:text-purple-400 bg-purple-100 dark:bg-purple-950"
    >
      best
    </InlineTag>
  );
}

export function EmbeddingModelBadge() {
  return (
    <InlineTag
      icon={<Fingerprint />}
      className="text-cyan-700 dark:text-cyan-400 bg-cyan-100 dark:bg-cyan-950"
    >
      embedding
    </InlineTag>
  );
}

export function PriceSourceBadge({ source }: { source: string }) {
  if (source === "custom") {
    return (
      <InlineTag className="text-blue-700 dark:text-blue-400 bg-blue-100 dark:bg-blue-950">
        custom
      </InlineTag>
    );
  }
  if (source === "default") {
    return (
      <InlineTag className="text-muted-foreground bg-muted">default</InlineTag>
    );
  }
  return null;
}
