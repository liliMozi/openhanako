/**
 * internal-browser.js — DEPRECATED
 *
 * The Electron browser control WebSocket (/internal/browser) has been moved
 * to server/index.js and uses a raw ws.WebSocketServer instead of Hono's
 * upgradeWebSocket. This is because WsTransport (lib/browser/browser-transport.js)
 * requires raw ws .on()/.off() event methods that Hono's WSContext doesn't expose.
 *
 * This file is kept as a tombstone to prevent accidental recreation.
 */
