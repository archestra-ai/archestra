"use client";

import { SettingsSectionStack } from "@/components/settings/settings-block";
import { DeletedItemsTable } from "./_components/deleted-items-table";
import { RetentionSection } from "./_components/retention-section";

export default function DeletedItemsSettingsPage() {
  return (
    <SettingsSectionStack>
      <RetentionSection />
      <DeletedItemsTable />
    </SettingsSectionStack>
  );
}
