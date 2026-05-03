import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { sessionFilesCacheDir } from "./session-file-registry.js";
import { serializeSessionFile } from "./session-file-response.js";

export function browserScreenshotExt(mimeType) {
  const lower = String(mimeType || "").toLowerCase();
  if (lower.includes("jpeg") || lower.includes("jpg")) return "jpg";
  if (lower.includes("webp")) return "webp";
  if (lower.includes("gif")) return "gif";
  return "png";
}

export function browserScreenshotFilename({ base64, mimeType } = {}) {
  if (!base64) throw new Error("browser screenshot base64 is required");
  const hash = createHash("sha256").update(String(base64)).digest("hex").slice(0, 16);
  return `browser-screenshot-${hash}.${browserScreenshotExt(mimeType)}`;
}

export function browserScreenshotPath(hanakoHome, sessionPath, { base64, mimeType } = {}) {
  return path.join(
    sessionFilesCacheDir(hanakoHome, sessionPath),
    browserScreenshotFilename({ base64, mimeType }),
  );
}

export async function persistBrowserScreenshotFile({
  hanakoHome,
  sessionPath,
  base64,
  mimeType = "image/png",
  registerSessionFile,
} = {}) {
  if (typeof registerSessionFile !== "function") {
    throw new Error("browser screenshot requires registerSessionFile");
  }
  const filePath = browserScreenshotPath(hanakoHome, sessionPath, { base64, mimeType });
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    await fs.promises.writeFile(filePath, Buffer.from(base64, "base64"));
  }
  return serializeSessionFile(await registerSessionFile({
    sessionPath,
    filePath,
    label: path.basename(filePath),
    origin: "browser_screenshot",
    storageKind: "managed_cache",
  }));
}

export function persistBrowserScreenshotFileSync({
  hanakoHome,
  sessionPath,
  base64,
  mimeType = "image/png",
  registerSessionFile,
} = {}) {
  if (typeof registerSessionFile !== "function") {
    throw new Error("browser screenshot requires registerSessionFile");
  }
  const filePath = browserScreenshotPath(hanakoHome, sessionPath, { base64, mimeType });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
  }
  return serializeSessionFile(registerSessionFile({
    sessionPath,
    filePath,
    label: path.basename(filePath),
    origin: "browser_screenshot",
    storageKind: "managed_cache",
  }));
}

export function browserScreenshotMediaItem(file) {
  if (!file?.fileId && !file?.id) return null;
  return {
    type: "session_file",
    fileId: file.fileId || file.id,
    sessionPath: file.sessionPath,
    filePath: file.filePath,
    filename: file.filename || path.basename(file.filePath || file.label || "browser-screenshot.png"),
    label: file.label || file.displayName || file.filename,
    mime: file.mime,
    size: file.size,
    kind: file.kind || "image",
  };
}
