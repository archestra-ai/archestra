import { AppaGithubSyncPanel } from "@/components/openappa/appa-github-sync-panel";
import { SettingsSectionStack } from "@/components/settings/settings-block";
import {
  OpenAppaAnnotatorModelSetting,
  OpenAppaBreakTheGlassSettings,
  OpenAppaClientCoverageSetting,
  OpenAppaEnforcementSetting,
} from "./_parts/openappa-settings-sections";

export default function OpenAppaSettingsPage() {
  return (
    <SettingsSectionStack className="max-w-4xl">
      <OpenAppaEnforcementSetting />
      <OpenAppaBreakTheGlassSettings />
      <OpenAppaAnnotatorModelSetting />
      <OpenAppaClientCoverageSetting />
      <AppaGithubSyncPanel />
    </SettingsSectionStack>
  );
}
