import React, { useEffect, useRef } from "react";
import { t, autoSaveConfig } from "../../helpers";
import { Toggle } from "../../widgets/Toggle";
import { SettingsSection } from "../../components/SettingsSection";
import { SettingsRow } from "../../components/SettingsRow";

// Local copy of OPTIONAL_TOOL_NAMES. Frontend intentionally does NOT import
// from shared/tool-categories.js to keep the desktop bundle independent of
// node-only server code. Drift between this constant and the backend's
// shared/tool-categories.js is caught by tests/optional-tool-names-drift.test.js
// (Task 10b) which imports both and asserts equality.
const OPTIONAL_TOOL_NAMES = [
  "browser",
  "cron",
  "dm",
  "install_skill",
  "update_settings",
] as const;

type OptionalToolName = (typeof OPTIONAL_TOOL_NAMES)[number];
const OPTIONAL_TOOL_NAME_SET = new Set<string>(OPTIONAL_TOOL_NAMES);

function normalizeDisabledTools(disabled: string[]) {
  return (disabled || []).filter((name) => OPTIONAL_TOOL_NAME_SET.has(name));
}

interface Props {
  availableTools?: string[];
  disabled: string[];
}

export function AgentToolsSection({ availableTools, disabled }: Props) {
  // Only render rows for tools the agent actually has registered.
  // This naturally hides dm in single-agent environments where the agent
  // has no channelsDir/agentsDir wiring.
  // If the field is absent (old backend / config still loading), render the
  // built-in optional list. An explicit [] still means "no optional tools".
  const renderable = Array.isArray(availableTools)
    ? OPTIONAL_TOOL_NAMES.filter((name) => availableTools.includes(name))
    : [...OPTIONAL_TOOL_NAMES];

  // Toggle visual state is derived from the `disabled` prop (no useState),
  // but writes must be computed from the freshest known list, not the prop
  // captured at the previous render. Rapid-click-before-prop-refresh would
  // otherwise rebuild `newDisabled` from stale data and silently clobber the
  // earlier click. disabledRef tracks the latest known value (updated both
  // by prop sync below and optimistically after each toggleTool call) so
  // two consecutive toggles on different tools before the first PUT+GET
  // round-trip both survive.
  const normalizedDisabled = normalizeDisabledTools(disabled);
  const disabledRef = useRef(normalizedDisabled);
  useEffect(() => {
    disabledRef.current = normalizedDisabled;
  }, [normalizedDisabled]);

  const toggleTool = (name: OptionalToolName) => {
    const current = disabledRef.current;
    const currentlyOff = current.includes(name);
    const newDisabled = currentlyOff
      ? current.filter((n) => n !== name)
      : [...current, name];
    disabledRef.current = newDisabled;
    autoSaveConfig({ tools: { disabled: newDisabled } });
  };

  if (renderable.length === 0) {
    return null;
  }

  return (
    <SettingsSection title={t("settings.agent.tools.title")}>
      <SettingsSection.Note>
        {t("settings.agent.tools.description")}
      </SettingsSection.Note>
      {renderable.map((name) => {
        const isOn = !normalizedDisabled.includes(name);
        return (
          <SettingsRow
            key={name}
            data-tool-name={name}
            label={t(`settings.agent.tools.items.${name}.label`)}
            hint={t(`settings.agent.tools.items.${name}.summary`)}
            control={<Toggle on={isOn} onChange={() => toggleTool(name)} />}
          />
        );
      })}
    </SettingsSection>
  );
}
