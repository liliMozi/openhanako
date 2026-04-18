// shared/tool-categories.js
//
// Single source of truth for built-in tool categorization.
//
// Every tool the engine registers (excluding plugin-contributed ones) MUST
// belong to exactly one of the three arrays below. A startup assertion enforces
// this — if a new tool is added without categorization, the engine refuses to
// boot with an error pointing here.
//
// Categories:
//   CORE     — Removing breaks the model. Never user-toggleable, never in UI.
//   STANDARD — Always-on built-in. Not in UI. Move to OPTIONAL to expose a toggle.
//   OPTIONAL — User-toggleable in AgentTab → Tools section. Default: all on.
//
// Plugin-contributed tools (flagged with _pluginId) are NOT part of this
// categorization. Plugin lifecycle is managed by PluginsTab.

export const CORE_TOOL_NAMES = [
  "read", "bash", "edit", "write", "grep", "find", "ls",
  "search_memory", "pin_memory", "unpin_memory",
  "web_search",
];

export const STANDARD_TOOL_NAMES = [
  "web_fetch",
  "todo_write",
  "create_artifact",
  "notify",
  "stage_files",
  "subagent",
  "channel",
  "record_experience",
  "recall_experience",
  "check_pending_tasks",
  "wait",
  "stop_task",
];

export const OPTIONAL_TOOL_NAMES = [
  "browser",
  "cron",
  "dm",
  "install_skill",
  "update_settings",
];

const OPTIONAL_TOOL_NAMES_SET = new Set(OPTIONAL_TOOL_NAMES);

/**
 * Default-off subset of OPTIONAL_TOOL_NAMES. Applied when agent config has no
 * `tools.disabled` field (i.e., user has never touched tool settings). Both
 * fresh agents and agents upgrading from a pre-feature version hit this path.
 *
 * Must be a subset of OPTIONAL_TOOL_NAMES. The frontend AgentTab keeps a local
 * copy for display defaults; tests/optional-tool-names-drift.test.js guards the
 * two from drifting.
 *
 * Rationale:
 *   update_settings — lets the agent modify app configuration; off by default
 *                     because silent config drift is surprising.
 *   dm              — direct-messages between agents; off by default because
 *                     single-agent setups have no peers and it adds context.
 */
export const DEFAULT_DISABLED_TOOL_NAMES = ["update_settings", "dm"];

/**
 * Startup-time invariant: every built-in tool the engine composes MUST be
 * explicitly categorized. Throwing here always means a developer added a tool
 * without categorizing it. The fix is always: open this file and categorize it.
 *
 * Caller passes already-filtered names (plugin tools excluded by caller).
 *
 * @param {string[]} actualToolNames
 * @throws {Error} if any tool is uncategorized
 */
export function assertAllToolsCategorized(actualToolNames) {
  const categorized = new Set([
    ...CORE_TOOL_NAMES,
    ...STANDARD_TOOL_NAMES,
    ...OPTIONAL_TOOL_NAMES,
  ]);
  const missing = actualToolNames.filter((n) => !categorized.has(n));
  if (missing.length > 0) {
    throw new Error(
      `Tools not categorized in shared/tool-categories.js: ${missing.join(", ")}.\n` +
      `Every built-in tool must be explicitly labeled as core / standard / optional. ` +
      `See the header of shared/tool-categories.js for the decision rules.`
    );
  }
}

/**
 * Compute the final tool name list for a newly created session.
 *
 * Rule: remove from allNames any name that is BOTH in the disabled list AND
 * in OPTIONAL_TOOL_NAMES. Core/standard tools are untouchable even if the
 * disabled list has been tampered with (runtime second-line defense).
 *
 * @param {string[]} allNames
 * @param {string[]} disabled
 * @returns {string[]} filtered tool names, order preserved from allNames
 */
export function computeToolSnapshot(allNames, disabled) {
  const effectivelyDisabled = new Set(
    (disabled || []).filter((n) => OPTIONAL_TOOL_NAMES_SET.has(n))
  );
  return allNames.filter((n) => !effectivelyDisabled.has(n));
}
