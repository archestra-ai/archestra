import { AppaGithubSyncPanel } from "@/app/openappa/_parts/appa-github-sync-panel";
import { SettingsSectionStack } from "@/components/settings/settings-block";
import {
  OpenAppaAnnotatorModelSetting,
  OpenAppaBreakTheGlassSetting,
  OpenAppaClientCoverageSetting,
  OpenAppaEnforcementSetting,
} from "./openappa-settings-sections";

export default function OpenAppaSettingsPage() {
  return (
    <SettingsSectionStack className="max-w-4xl">
      <OpenAppaEnforcementSetting />
      <OpenAppaBreakTheGlassSetting />
      <OpenAppaAnnotatorModelSetting />
      <OpenAppaClientCoverageSetting />
      <AppaGithubSyncPanel />
    </SettingsSectionStack>
  );
}
