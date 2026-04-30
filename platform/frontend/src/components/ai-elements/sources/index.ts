"use client";

import {
  Source,
  type SourceProps,
  SourcesContent,
  type SourcesContentProps,
  Sources as RootSources,
  type SourcesProps,
  SourcesTrigger,
  type SourcesTriggerProps,
} from "./sources";

export type {
  SourceProps,
  SourcesContentProps,
  SourcesProps,
  SourcesTriggerProps,
};

export const Sources = Object.assign(RootSources, {
  Content: SourcesContent,
  Source,
  Trigger: SourcesTrigger,
});
