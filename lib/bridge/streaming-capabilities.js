/**
 * Platform-owned outbound text streaming capability declaration.
 *
 * BridgeManager reads this declaration to choose delivery behavior. Adapter
 * methods remain the actual platform boundary.
 */

const STREAMING_MODES = new Set(["draft", "edit_message", "block", "batch"]);

/**
 * @param {object} opts
 * @param {string} opts.platform
 * @param {"draft"|"edit_message"|"block"|"batch"} opts.mode
 * @param {string[]} [opts.scopes]
 * @param {number} [opts.minIntervalMs]
 * @param {number} [opts.maxChars]
 * @param {string} [opts.source]
 */
export function createStreamingCapabilities({
  platform,
  mode,
  scopes = ["dm"],
  minIntervalMs = 500,
  maxChars = 4096,
  source = "",
}) {
  if (!platform) throw new Error("streaming capability requires platform");
  if (!STREAMING_MODES.has(mode)) throw new Error(`unsupported streaming mode: ${mode}`);
  return Object.freeze({
    platform,
    mode,
    scopes: Object.freeze([...scopes]),
    minIntervalMs,
    maxChars,
    source,
  });
}
