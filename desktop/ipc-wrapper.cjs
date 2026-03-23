const { ipcMain } = require('electron');

/**
 * Non-breaking IPC handler wrapper.
 * Adds structured error logging as a safety net. Does NOT change return format.
 * If an error escapes the handler, it is logged and undefined is returned.
 */
function wrapIpcHandler(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...args);
    } catch (err) {
      const traceId = Math.random().toString(16).slice(2, 10);
      console.error(`[IPC][${channel}][${traceId}] ${err?.message || err}`);
      return undefined;
    }
  });
}

function wrapIpcOn(channel, handler) {
  ipcMain.on(channel, (event, ...args) => {
    try {
      handler(event, ...args);
    } catch (err) {
      console.error(`[IPC][${channel}] ${err?.message || err}`);
    }
  });
}

module.exports = { wrapIpcHandler, wrapIpcOn };
