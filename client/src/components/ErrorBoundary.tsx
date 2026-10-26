import { t } from '../i18n';
import { Component, type ReactNode, type ErrorInfo } from 'react';

interface Props {
  readonly children: ReactNode;
}

interface State {
  readonly error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div style={{ padding: '40px 24px', maxWidth: 560 }}>
        <h2 style={{ margin: '0 0 12px', fontSize: 18, fontWeight: 500 }}>
          {t('Something went wrong')}
        </h2>
        <pre
          style={{
            margin: 0,
            padding: 16,
            borderRadius: 8,
            background: 'var(--bg-1, #1a1a2e)',
            border: '1px solid var(--border-0, #333)',
            color: 'var(--danger, #e55)',
            fontSize: 13,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
          }}
        >
          {this.state.error.message}
        </pre>
        <button
          className="btn"
          style={{ marginTop: 16 }}
          onClick={() => this.setState({ error: null })}
        >
          {t('Try again')}
        </button>
      </div>
    );
  }
}
