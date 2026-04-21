/**
 * Resolve a plugin title to a display string based on current locale.
 * Priority: exact match -> language prefix -> 'en' -> first value -> fallback.
 */
export function resolvePluginTitle(
  title: string | Record<string, string>,
  locale: string,
  fallback?: string,
): string {
  if (typeof title === 'string') return title;
  if (title[locale]) return title[locale];
  const prefix = locale.split('-')[0];
  if (prefix !== locale && title[prefix]) return title[prefix];
  if (title.en) return title.en;
  const values = Object.values(title);
  if (values.length > 0) return values[0];
  return fallback || '';
}

/**
 * Get the icon display for a plugin. Returns SVG string if available,
 * otherwise the first character of the resolved title.
 */
export function resolvePluginIcon(
  icon: string | null,
  title: string | Record<string, string>,
  locale: string,
): { type: 'svg' | 'text'; content: string } {
  if (icon && icon.trim().startsWith('<')) {
    return { type: 'svg', content: icon };
  }
  const resolved = resolvePluginTitle(title, locale);
  return { type: 'text', content: resolved.charAt(0) || '?' };
}
