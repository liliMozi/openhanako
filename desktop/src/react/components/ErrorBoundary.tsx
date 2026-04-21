import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** 可选的回退 UI 区域名称，用于错误提示 */
  region?: string;
}

interface State {
  error: Error | null;
  errorType: 'render' | 'network' | 'unknown';
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, errorType: 'unknown' };

  static getDerivedStateFromError(error: Error): State {
    // 区分错误类型
    const msg = error.message?.toLowerCase() || '';
    if (msg.includes('fetch') || msg.includes('network') || msg.includes('abort') || msg.includes('timeout')) {
      return { error, errorType: 'network' };
    }
    return { error, errorType: 'render' };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
    window.__hanaLog?.('error', 'react', `${error.message}\n${info.componentStack}`);
  }

  handleRetry = () => {
    this.setState({ error: null, errorType: 'unknown' });
  };

  render() {
    if (this.state.error) {
      const { errorType } = this.state;
      const region = this.props.region;

      const title = errorType === 'network'
        ? 'Connection issue'
        : 'Something went wrong';

      const hint = errorType === 'network'
        ? 'Check your connection and try again.'
        : region
          ? `An error occurred in ${region}.`
          : 'An unexpected error occurred.';

      return (
        <div style={{
          padding: '24px',
          color: 'var(--text-secondary, #888)',
          fontSize: '13px',
          textAlign: 'center',
        }}>
          <p style={{ marginBottom: '4px', fontWeight: 500 }}>{title}</p>
          <p style={{ marginBottom: '12px', fontSize: '12px', opacity: 0.7 }}>{hint}</p>
          <button
            onClick={this.handleRetry}
            style={{
              background: 'none',
              border: '1px solid var(--border-light, #ddd)',
              borderRadius: '4px',
              padding: '4px 12px',
              cursor: 'pointer',
              color: 'inherit',
              fontSize: '12px',
            }}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
