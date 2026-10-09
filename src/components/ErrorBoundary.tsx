import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Crash surface. The app runs a local model and a native shell, so the failure
 * modes worth catching are the ones a user can act on: a model that will not
 * load, an index that will not build. Everything else still falls through here.
 */

type Props = { children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Application error", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-full items-center justify-center bg-canvas p-8">
        <div className="max-w-md rounded-lg border border-line-strong bg-surface-container-low p-6 shadow-lg">
          <h1 className="text-headline-md font-semibold text-error">
            Something broke
          </h1>
          <p className="mt-2 text-body-md text-on-surface-variant">
            The interface hit an unexpected error. Reloading usually clears it;
            the index itself is held in this process and will need to be rebuilt.
          </p>
          <pre className="mt-4 max-h-40 overflow-auto rounded bg-surface-container-lowest p-3 text-code-sm text-on-surface-variant">
            {error.message}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="press mt-4 rounded bg-primary-container px-4 py-2 text-label-md font-semibold text-on-primary-container"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
