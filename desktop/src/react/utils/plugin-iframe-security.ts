export function getPluginIframeOrigin(routeUrl: string | null): string | null {
  if (!routeUrl) return null;
  try {
    return new URL(routeUrl).origin;
  } catch (err) {
    console.warn('[plugin-iframe] invalid routeUrl, messaging disabled:', routeUrl, err);
    return null;
  }
}

export function isTrustedPluginIframeMessage(
  event: MessageEvent,
  iframeWindow: Window | null | undefined,
  expectedOrigin: string | null,
): boolean {
  if (!iframeWindow) return false;
  if (!expectedOrigin) return false;
  if (event.source !== iframeWindow) return false;
  return event.origin === expectedOrigin;
}
