const _messageLiveVersionBySession: Record<string, number> = {};

export function readMessageLiveVersion(sessionPath: string): number {
  return _messageLiveVersionBySession[sessionPath] ?? 0;
}

export function bumpMessageLiveVersion(sessionPath: string): number {
  const next = (_messageLiveVersionBySession[sessionPath] ?? 0) + 1;
  _messageLiveVersionBySession[sessionPath] = next;
  return next;
}

export function clearMessageLiveVersion(sessionPath?: string): void {
  if (sessionPath == null) {
    for (const key of Object.keys(_messageLiveVersionBySession)) {
      delete _messageLiveVersionBySession[key];
    }
    return;
  }
  delete _messageLiveVersionBySession[sessionPath];
}
