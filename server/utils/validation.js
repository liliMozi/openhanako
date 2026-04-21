import fs from "fs";
import path from "path";

export function validateId(id) {
  return id && !id.includes("..") && !id.includes("/") && !id.includes("\\");
}

export function agentExists(engine, id) {
  return fs.existsSync(path.join(engine.agentsDir, id, "config.yaml"));
}
