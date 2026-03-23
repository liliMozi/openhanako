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
  error: {
    code: string;
    severity: ErrorSeverity;
    category: ErrorCategory;
    retryable: boolean;
    userMessageKey: string;
    httpStatus: number;
    context: Record<string, unknown>;
    traceId: string;
    message: string;
  };
  timestamp: number;
  breadcrumbs: Breadcrumb[];
}
