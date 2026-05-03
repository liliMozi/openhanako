export function serializeSessionFile(file) {
  if (!file) return null;
  const id = file.id || file.fileId || null;
  return {
    ...(id ? { id, fileId: id } : {}),
    ...(file.sessionPath ? { sessionPath: file.sessionPath } : {}),
    filePath: file.filePath,
    ...(file.realPath ? { realPath: file.realPath } : {}),
    ...(file.displayName ? { displayName: file.displayName } : {}),
    ...(file.filename ? { filename: file.filename } : {}),
    ...(file.label ? { label: file.label } : {}),
    ...(file.ext !== undefined ? { ext: file.ext } : {}),
    ...(file.mime ? { mime: file.mime } : {}),
    ...(file.size !== undefined ? { size: file.size } : {}),
    ...(file.kind ? { kind: file.kind } : {}),
    ...(file.isDirectory !== undefined ? { isDirectory: file.isDirectory } : {}),
    ...(file.origin ? { origin: file.origin } : {}),
    ...(file.createdAt !== undefined ? { createdAt: file.createdAt } : {}),
    ...(file.storageKind ? { storageKind: file.storageKind } : {}),
    ...(file.status ? { status: file.status } : {}),
    ...(file.missingAt !== undefined ? { missingAt: file.missingAt } : {}),
  };
}

export function registerSessionFileFromRequest(engine, { sessionPath, filePath, label, origin, storageKind }) {
  if (!sessionPath) return null;
  if (typeof engine?.registerSessionFile !== "function") {
    throw new Error("session file registry unavailable");
  }
  return serializeSessionFile(engine.registerSessionFile({
    sessionPath,
    filePath,
    label,
    origin,
    storageKind,
  }));
}
