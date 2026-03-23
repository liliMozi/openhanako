export type ErrorSeverity = 'critical' | 'degraded' | 'cosmetic';
export type ErrorCategory = 'network' | 'llm' | 'filesystem' | 'ipc' | 'render' | 'bridge' | 'config' | 'auth' | 'unknown';
export type ErrorRoute = 'toast' | 'statusbar' | 'boundary' | 'silent';

export interface ErrorDef {
  severity: ErrorSeverity;
  category: ErrorCategory;
  i18nKey: string;
  retryable: boolean;
  httpStatus?: number;
}

export interface Breadcrumb {
  type: 'action' | 'navigation' | 'network' | 'ipc' | 'llm' | 'filesystem' | 'lifecycle';
  message: string;
  timestamp: number;
  data?: Record<string, unknown>;
}

export interface ErrorEntry {
  error: import('../../../../shared/errors.js').AppError;
  timestamp: number;
  breadcrumbs: Breadcrumb[];
}
