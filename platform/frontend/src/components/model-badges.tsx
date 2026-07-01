import { Clock, Fingerprint, Github, Sparkles, Star, User } from "lucide-react";
import { InlineTag } from "@/components/ui/inline-tag";

/**
 * Marks a model from a per-user provider (e.g. GitHub Copilot): the same model
 * is available to everyone, but each member runs it on their own connected
 * account, so there's no single shared key behind it.
 */
export function PerUserModelBadge() {
  return (
    <InlineTag icon={<User />} className="text-muted-foreground bg-muted">
      per-user
    </InlineTag>
  );
}

/**
 * Shown on a per-user provider model (e.g. GitHub Copilot) the viewer hasn't
 * connected yet: the model is selectable, but using it prompts them to link
 * their own account first.
 */
export function ConnectAccountBadge() {
  return (
    <InlineTag
      icon={<Github />}
      className="text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-950"
    >
      connect your account
    </InlineTag>
  );
}

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

/**
 * Marks an older-generation model that is still selectable but superseded by a
 * newer generation from the same provider.
 */
export function OldModelBadge() {
  return (
    <InlineTag icon={<Clock />} className="text-muted-foreground bg-muted">
      old
    </InlineTag>
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
