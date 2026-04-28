"use client";

import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MemoryList } from "./_parts/memory-list";
import { MemorySettings } from "./_parts/memory-settings";

export default function MemorySettingsPage() {
  return (
    <ErrorBoundary>
      <Tabs defaultValue="records">
        <TabsList>
          <TabsTrigger value="records">Records</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="records">
          <MemoryList />
        </TabsContent>
        <TabsContent value="settings">
          <MemorySettings />
        </TabsContent>
      </Tabs>
    </ErrorBoundary>
  );
}
