import { AppError } from './errors.js';
import { errorBus } from './error-bus.js';

export function safeParseJSON(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch (err) {
    errorBus.report(new AppError('CONFIG_PARSE', { cause: err, context: { textPreview: String(text).slice(0, 100) } }));
    return fallback;
  }
}

export async function safeParseResponse(res, fallback = null) {
  try {
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      errorBus.report(new AppError('FETCH_SERVER_ERROR', {
        message: `HTTP ${res.status}: ${body.slice(0, 200)}`,
        context: { status: res.status, url: res.url },
      }));
      return fallback;
    }
    return await res.json();
  } catch (err) {
    errorBus.report(new AppError('CONFIG_PARSE', { cause: err, context: { url: res?.url } }));
    return fallback;
  }
}
