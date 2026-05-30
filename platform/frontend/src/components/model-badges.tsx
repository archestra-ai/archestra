import { Fingerprint, Sparkles, Star } from "lucide-react";
import { InlineTag } from "@/components/ui/inline-tag";

export function FreeModelBadge() {
  return (
    <InlineTag
      icon={<Sparkles />}
      className="text-green-700 dark:text-green-400 bg-green-100 dark:bg-green-950"
    >
      free
    </InlineTag>
  );
}

export function LatestModelBadge() {
  return (
    <InlineTag className="text-muted-foreground bg-muted">latest</InlineTag>
  );
}

export function UnknownCapabilitiesBadge() {
  return (
    <InlineTag className="text-muted-foreground bg-muted">
      capabilities unknown
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
