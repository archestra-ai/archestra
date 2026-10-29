"use client";

import type { ComponentProps } from "react";
import { appInteractive } from "@/lib/app-interactive";
import { lazyComponent } from "@/lib/utils/preloadable-lazy";
import type * as AddTools from "./add-tools-view";
import type * as ChooseTools from "./choose-tools-view";
import type * as Knowledge from "./knowledge-view";
import type * as Settings from "./settings-view";
import type * as Subagents from "./subagents-view";

// The agent quick-edit dialog's views (settings, tools, knowledge, subagents)
// open only when someone edits an agent from the composer, so they are not
// part of the first load: each is a lazy chunk, preloaded on the first idle
// callback after the composer hydrates.

export type { QuickEditNotice } from "./settings-view";

export const AgentSettingsView = lazyComponent<
  ComponentProps<typeof Settings.AgentSettingsView>
>(() => import("./settings-view").then((m) => m.AgentSettingsView));
export const AgentSettingsSkeleton = lazyComponent<
  ComponentProps<typeof Settings.AgentSettingsSkeleton>
>(() => import("./settings-view").then((m) => m.AgentSettingsSkeleton));
export const AddToolsView = lazyComponent<
  ComponentProps<typeof AddTools.AddToolsView>
>(() => import("./add-tools-view").then((m) => m.AddToolsView));
export const ConnectView = lazyComponent<
  ComponentProps<typeof AddTools.ConnectView>
>(() => import("./add-tools-view").then((m) => m.ConnectView));
export const InstallingView = lazyComponent<
  ComponentProps<typeof AddTools.InstallingView>
>(() => import("./add-tools-view").then((m) => m.InstallingView));
export const ChooseToolsView = lazyComponent<
  ComponentProps<typeof ChooseTools.ChooseToolsView>
>(() => import("./choose-tools-view").then((m) => m.ChooseToolsView));
export const KnowledgeView = lazyComponent<
  ComponentProps<typeof Knowledge.KnowledgeView>
>(() => import("./knowledge-view").then((m) => m.KnowledgeView));
export const SubagentsView = lazyComponent<
  ComponentProps<typeof Subagents.SubagentsView>
>(() => import("./subagents-view").then((m) => m.SubagentsView));

// ===

const views = [
  AgentSettingsView,
  AgentSettingsSkeleton,
  AddToolsView,
  ConnectView,
  InstallingView,
  ChooseToolsView,
  KnowledgeView,
  SubagentsView,
];

if (typeof window !== "undefined") {
  void appInteractive.whenIdle().then(() => {
    for (const view of views) void view.preload();
  });
}
