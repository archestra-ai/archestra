"use client";

import dynamic from "next/dynamic";

// Lazy boundary shared by the app frame and the chat app container so the
// dialog's react-hook-form + dialog deps stay out of their initial bundles —
// the chunk is fetched on first pencil click. Importing this module is cheap;
// it does not statically pull in the dialog implementation.
export const AppEditModelContextDialog = dynamic(
  async () =>
    (await import("@/components/mcp-app/app-edit-model-context-dialog"))
      .AppEditModelContextDialog,
  { ssr: false },
);
