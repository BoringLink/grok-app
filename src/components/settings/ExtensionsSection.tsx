/**
 * Settings → extensions section (consumes SettingsModel context).
 */
import { useSettingsModel } from "@/providers/SettingsModelContext";

import { ExtensionsPanel } from "@/components/ExtensionsPanel";
import { resolveLocale } from "@/i18n";


export function ExtensionsSection() {
  const s = useSettingsModel();
  const {
    activeTab,
    cliInfo,
    locale,
    navigateTo,
    onSkillsPrefsChanged,
    projectPath,
    sessionDataMode,
    setSectionTab,
  } = s;

  return (
    <>
<ExtensionsPanel
            locale={resolveLocale(locale)}
            projectPath={projectPath}
            sessionDataMode={sessionDataMode}
            cliFound={cliInfo.found}
            activeTab={
              (activeTab as
                | "plugins"
                | "skills"
                | "mcp"
                | "agents"
                | "hooks"
                | "rules"
                | "commands"
                | "market" // legacy hash → plugins inside panel
                | null) ?? "plugins"
            }
            onTabChange={(next) => setSectionTab(next)}
            onOpenRuntime={() => navigateTo("runtime", "cli")}
            onSkillsPrefsChanged={onSkillsPrefsChanged}
          />
    </>
  );
}
