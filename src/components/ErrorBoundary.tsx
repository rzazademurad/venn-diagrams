/**
 * Top-level error boundary: an unexpected exception anywhere in the tree
 * shows a recoverable panel (with the error text for bug reports) instead of
 * a blank page.
 */

import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = { error: null };

  public static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  public componentDidCatch(error: Error): void {
    console.error('[venn] unhandled error:', error);
  }

  public render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="flex h-full items-center justify-center bg-slate-100 p-6 dark:bg-slate-950">
        <div className="w-full max-w-lg rounded-xl border border-rose-200 bg-white p-6 shadow-xl dark:border-rose-900 dark:bg-slate-900">
          <h1 className="text-lg font-bold text-rose-700 dark:text-rose-300">Something went wrong</h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            The application hit an unexpected error. Your statement history and settings are safe.
          </p>
          <pre className="mt-3 max-h-40 overflow-auto rounded-lg bg-slate-50 p-3 font-mono text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-200">
            {this.state.error.message}
          </pre>
          <div className="mt-4 flex gap-2">
            <button
              className="rounded-lg bg-uom-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-uom-500"
              onClick={() => this.setState({ error: null })}
            >
              Try to continue
            </button>
            <button
              className="rounded-lg border border-slate-300 px-4 py-1.5 text-sm font-semibold text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
