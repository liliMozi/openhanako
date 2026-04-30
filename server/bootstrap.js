import path from "path";
import { pathToFileURL } from "url";

function log(line) {
  try {
    process.stdout.write(`${line}\n`);
  } catch {}
}

function logError(line) {
  try {
    process.stderr.write(`${line}\n`);
  } catch {}
}

const hanaRoot = process.env.HANA_ROOT || path.resolve(import.meta.dirname, "..");
const serverEntry = process.env.HANA_SERVER_ENTRY || path.join(hanaRoot, "bundle", "index.js");

log(`[server-bootstrap] process started pid=${process.pid} platform=${process.platform} arch=${process.arch}`);
log(`[server-bootstrap] node=${process.version} hanaHome=${process.env.HANA_HOME || "unset"}`);
log(`[server-bootstrap] root=${hanaRoot}`);
log(`[server-bootstrap] entry=${serverEntry}`);

try {
  await import(pathToFileURL(serverEntry).href);
} catch (err) {
  logError(`[server-bootstrap] failed to import server entry: ${err?.stack || err?.message || String(err)}`);
  process.exitCode = 1;
  throw err;
}
