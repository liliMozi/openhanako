// shared/error-bus.js
import { AppError } from './errors.js';

export class ErrorBus {
  constructor() {
    this._listeners = [];
    this._breadcrumbs = [];
    this._maxBreadcrumbs = 50;
    this._recentFingerprints = new Map();
    this._dedupeWindowMs = 5000;
  }

  addBreadcrumb(crumb) {
    if (this._breadcrumbs.length >= this._maxBreadcrumbs) this._breadcrumbs.shift();
    this._breadcrumbs.push({ ...crumb, timestamp: Date.now() });
  }

  report(error, extra) {
    const appErr = AppError.wrap(error);
    if (extra?.context) Object.assign(appErr.context, extra.context);

    // Dedup: default fingerprint is just the error code
    const fingerprint = extra?.dedupeKey || appErr.code;
    const lastSeen = this._recentFingerprints.get(fingerprint);
    if (lastSeen && Date.now() - lastSeen < this._dedupeWindowMs) return;
    this._recentFingerprints.set(fingerprint, Date.now());

    // Periodic cleanup of stale fingerprints (prevent memory leak)
    if (this._recentFingerprints.size > 200) {
      const now = Date.now();
      for (const [k, v] of this._recentFingerprints) {
        if (now - v > this._dedupeWindowMs) this._recentFingerprints.delete(k);
      }
    }

    const route = extra?.route || this._autoRoute(appErr);
    const entry = {
      error: appErr,
      timestamp: Date.now(),
      breadcrumbs: [...this._breadcrumbs],
    };

    // Always log
    this._log(entry);

    // Notify listeners
    for (const listener of this._listeners) {
      try { listener(entry, route); } catch { /* listener errors must not crash the bus */ }
    }
  }

  subscribe(listener) {
    this._listeners.push(listener);
    return () => { this._listeners = this._listeners.filter(l => l !== listener); };
  }

  _autoRoute(err) {
    if (err.code === 'WS_DISCONNECTED') return 'statusbar';
    if (err.severity === 'critical') return 'boundary';
    return 'toast';
  }

  _log(entry) {
    const { error } = entry;
    console.error(`[ErrorBus][${error.code}][${error.traceId}] ${error.message}`, error.context);
  }
}

// Global singleton per process
export const errorBus = new ErrorBus();
