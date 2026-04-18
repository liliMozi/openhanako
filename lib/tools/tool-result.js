/**
 * Standardized tool result constructors.
 * All Pi SDK tools return { content: ContentBlock[], details?: object }.
 */

export function toolOk(text, details = {}) {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

export function toolError(text, details = {}) {
  return {
    content: [{ type: "text", text }],
    details: { ...details, error: text },
  };
}
