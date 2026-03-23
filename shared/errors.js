export const ErrorSeverity = Object.freeze({
  CRITICAL: 'critical',
  DEGRADED: 'degraded',
  COSMETIC: 'cosmetic',
});

export const ErrorCategory = Object.freeze({
  NETWORK: 'network', LLM: 'llm', FILESYSTEM: 'filesystem',
  IPC: 'ipc', RENDER: 'render', BRIDGE: 'bridge',
  CONFIG: 'config', AUTH: 'auth', UNKNOWN: 'unknown',
});

export const ERROR_DEFS = Object.freeze({
  LLM_TIMEOUT:         { severity: 'degraded', category: 'llm',        i18nKey: 'error.llmTimeout',        retryable: true,  httpStatus: 504 },
  LLM_RATE_LIMITED:    { severity: 'degraded', category: 'llm',        i18nKey: 'error.llmRateLimited',    retryable: true,  httpStatus: 429 },
  LLM_EMPTY_RESPONSE:  { severity: 'degraded', category: 'llm',        i18nKey: 'error.llmEmptyResponse',  retryable: true,  httpStatus: 502 },
  LLM_AUTH_FAILED:     { severity: 'degraded', category: 'llm',        i18nKey: 'error.llmAuthFailed',     retryable: false, httpStatus: 401 },
  LLM_SLOW_RESPONSE:   { severity: 'cosmetic', category: 'llm',        i18nKey: 'error.llmSlowResponse',   retryable: false },
  FS_PERMISSION:       { severity: 'critical', category: 'filesystem', i18nKey: 'error.fsPermission',      retryable: false, httpStatus: 500 },
  FS_NOT_FOUND:        { severity: 'degraded', category: 'filesystem', i18nKey: 'error.fsNotFound',        retryable: false, httpStatus: 404 },
  FS_COPY_FAILED:      { severity: 'critical', category: 'filesystem', i18nKey: 'error.fsCopyFailed',      retryable: true,  httpStatus: 500 },
  WS_DISCONNECTED:     { severity: 'degraded', category: 'network',    i18nKey: 'error.wsDisconnected',    retryable: true },
  FETCH_TIMEOUT:       { severity: 'degraded', category: 'network',    i18nKey: 'error.fetchTimeout',      retryable: true,  httpStatus: 504 },
  FETCH_SERVER_ERROR:  { severity: 'degraded', category: 'network',    i18nKey: 'error.fetchServerError',  retryable: true,  httpStatus: 502 },
  IPC_FAILED:          { severity: 'degraded', category: 'ipc',        i18nKey: 'error.ipcFailed',         retryable: false },
  RENDER_CRASH:        { severity: 'critical', category: 'render',     i18nKey: 'error.renderCrash',       retryable: false },
  CONFIG_PARSE:        { severity: 'critical', category: 'config',     i18nKey: 'error.configParse',       retryable: false, httpStatus: 500 },
  BRIDGE_SEND_FAILED:  { severity: 'degraded', category: 'bridge',     i18nKey: 'error.bridgeSendFailed',  retryable: true,  httpStatus: 502 },
  SKILL_SYNC_FAILED:   { severity: 'degraded', category: 'filesystem', i18nKey: 'error.skillSyncFailed',   retryable: true,  httpStatus: 500 },
  MEMORY_COMPILE_FAILED: { severity: 'degraded', category: 'unknown',  i18nKey: 'error.memoryCompileFailed', retryable: true },
  DB_ERROR:            { severity: 'critical', category: 'filesystem', i18nKey: 'error.dbError',           retryable: false, httpStatus: 500 },
  SERVER_AUTH_FAILED:  { severity: 'degraded', category: 'auth',       i18nKey: 'error.serverAuthFailed',  retryable: false, httpStatus: 403 },
  UNKNOWN:             { severity: 'degraded', category: 'unknown',    i18nKey: 'error.unknown',           retryable: false, httpStatus: 500 },
});

export class AppError extends Error {
  constructor(code, opts = {}) {
    const def = ERROR_DEFS[code] || ERROR_DEFS.UNKNOWN;
    super(opts.message || code);
    this.name = 'AppError';
    this.code = code;
    this.severity = def.severity;
    this.category = def.category;
    this.retryable = def.retryable;
    this.userMessageKey = def.i18nKey;
    this.httpStatus = def.httpStatus || 500;
    this.context = opts.context || {};
    this.traceId = opts.traceId || Math.random().toString(16).slice(2, 10);
    if (opts.cause) this.cause = opts.cause;
  }

  toJSON() {
    return { code: this.code, message: this.message, context: this.context, traceId: this.traceId };
  }

  static fromJSON(data) {
    return new AppError(data.code || 'UNKNOWN', {
      message: data.message,
      context: data.context,
      traceId: data.traceId,
    });
  }

  static wrap(err, fallbackCode = 'UNKNOWN') {
    if (err instanceof AppError) return err;
    const raw = err instanceof Error ? err : new Error(String(err));
    return new AppError(fallbackCode, { cause: raw, message: raw.message });
  }
}
