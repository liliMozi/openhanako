/**
 * hono-helpers.js — Hono migration utilities
 */

/** Safe JSON body parse — returns fallback on empty body or non-JSON */
export async function safeJson(c, fallback = {}) {
  try {
    const text = await c.req.text();
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}
