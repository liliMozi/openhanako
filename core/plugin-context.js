import fs from "fs";
import path from "path";

/**
 * Create a PluginContext for a plugin.
 * @param {{ pluginId: string, pluginDir: string, dataDir: string, bus: object, accessLevel?: "full-access" | "restricted" }} opts
 */
export function createPluginContext({ pluginId, pluginDir, dataDir, bus, accessLevel }) {
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

  return { pluginId, pluginDir, dataDir, bus: pluginBus, config, log };
}
