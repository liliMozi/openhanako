import { Component, type ReactNode } from 'react';
import styles from './RegionalErrorBoundary.module.css';

declare function t(key: string, vars?: Record<string, string | number>): string;

interface Props {
  region: string;
  resetKeys?: unknown[];
  children: ReactNode;
}

interface State {
  error: Error | null;
  prevResetKeys: unknown[];
}

export class RegionalErrorBoundary extends Component<Props, State> {
  state: State = { error: null, prevResetKeys: this.props.resetKeys || [] };

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKeys && state.error) {
      const changed = props.resetKeys.some((k, i) => k !== state.prevResetKeys[i]);
      if (changed) return { error: null, prevResetKeys: props.resetKeys };
    }
    if (props.resetKeys) return { prevResetKeys: props.resetKeys };
    return null;
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Import dynamically to avoid circular deps and TS issues with JS imports
    import('../../../../shared/error-bus.js').then(({ errorBus }) => {
      import('../../../../shared/errors.js').then(({ AppError }) => {
        errorBus.report(new AppError('RENDER_CRASH', {
          cause: error,
          context: { region: this.props.region, componentStack: info.componentStack?.slice(0, 500) },
        }));
      });
    });
  }

  handleRetry = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <div className={styles.fallback}>
          <p className={styles.message}>{t('error.regionUnavailable')}</p>
          <button className={styles.retry} onClick={this.handleRetry}>
            {t('action.retry')}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
