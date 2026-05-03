import fs from "fs";
import path from "path";
import { serializeSessionFile } from "../lib/session-files/session-file-response.js";

/**
 * Create a PluginContext for a plugin.
 * @param {{ pluginId: string, pluginDir: string, dataDir: string, bus: object, accessLevel?: "full-access" | "restricted", registerSessionFile?: Function }} opts
 */
export function createPluginContext({ pluginId, pluginDir, dataDir, bus, accessLevel, registerSessionFile: registerSessionFileImpl }) {
  const configPath = path.join(dataDir, "config.json");

  const config = {
    get(key) {
      try {
        const data = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        return key ? data[key] : data;
      } catch {
        return key ? undefined : {};
      }
    },
    set(key, value) {
      fs.mkdirSync(dataDir, { recursive: true });
      const data = config.get() || {};
      data[key] = value;
      fs.writeFileSync(configPath, JSON.stringify(data, null, 2), "utf-8");
    },
  };

  const resolvedAccess = accessLevel || "restricted";
  const pluginBus = resolvedAccess === "full-access"
    ? bus
    : Object.freeze({
        emit: bus.emit.bind(bus),
        subscribe: bus.subscribe.bind(bus),
        request: bus.request.bind(bus),
        hasHandler: bus.hasHandler.bind(bus),
      });

  const prefix = `[plugin:${pluginId}]`;
  const log = {
    info: (...args) => console.log(prefix, ...args),
    warn: (...args) => console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args),
    debug: (...args) => console.debug(prefix, ...args),
  };

  function registerSessionFile(entry = {}) {
    if (typeof registerSessionFileImpl !== "function") {
      throw new Error("plugin session file registry unavailable");
    }
    const { sessionPath, filePath, label, origin = "plugin_output" } = entry;
    const storageKind = origin === "plugin_output" ? "plugin_data" : "external";
    if (!sessionPath) throw new Error("plugin registerSessionFile requires sessionPath");
    if (!filePath || !path.isAbsolute(filePath)) {
      throw new Error("plugin registerSessionFile requires an absolute filePath");
    }
    return serializeSessionFile(registerSessionFileImpl({
      sessionPath,
      filePath,
      label,
      origin,
      storageKind,
    }));
  }

  return { pluginId, pluginDir, dataDir, bus: pluginBus, config, log, registerSessionFile };
}
