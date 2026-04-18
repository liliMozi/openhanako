import yaml from "js-yaml";

const MAX_DESCRIPTION_LENGTH = 1024;

function normalizeName(value, fallbackName) {
  if (typeof value !== "string") return fallbackName;
  const trimmed = value.trim();
  return trimmed || fallbackName;
}

function normalizeDescription(value) {
  if (typeof value !== "string") return "";
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  return collapsed.length > MAX_DESCRIPTION_LENGTH
    ? collapsed.slice(0, MAX_DESCRIPTION_LENGTH)
    : collapsed;
}

/**
 * Parse SKILL.md frontmatter using the same trust boundary as the upstream spec:
 * only YAML frontmatter contributes metadata, never arbitrary body content.
 */
export function parseSkillMetadata(content, fallbackName = "") {
  const meta = {
    name: fallbackName,
    description: "",
    disableModelInvocation: false,
  };

  if (typeof content !== "string" || !content.startsWith("---")) return meta;
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return meta;

  try {
    const parsed = yaml.load(match[1]);
    if (!parsed || typeof parsed !== "object") return meta;
    return {
      name: normalizeName(parsed.name, fallbackName),
      description: normalizeDescription(parsed.description),
      disableModelInvocation: parsed["disable-model-invocation"] === true,
    };
  } catch {
    return meta;
  }
}
