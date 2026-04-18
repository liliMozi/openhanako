/**
 * Developer-side icon registry for slash menu items.
 * Fallback: four-pointed star for all skills.
 */

export const SKILL_STAR_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M8 1 L9.5 6 L15 8 L9.5 10 L8 15 L6.5 10 L1 8 L6.5 6 Z"/></svg>`;

const overrides: Record<string, string> = {
  // Add per-skill icon overrides here:
  // 'diary': '<svg ...>...</svg>',
};

export function getSkillIcon(name: string): string {
  return overrides[name] ?? SKILL_STAR_ICON;
}
