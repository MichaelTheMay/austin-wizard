import React from "react";

type State = { hasError: boolean; error?: Error };

export default class ErrorBoundary extends React.Component<React.PropsWithChildren<{}>, State> {
  constructor(props: React.PropsWithChildren<{}>) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(_error: Error, _info: any) {
    // Could hook into telemetry here
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-6 bg-rose-50 text-rose-800 rounded">
          <h3 className="font-bold">Something went wrong.</h3>
          <pre className="whitespace-pre-wrap mt-2 text-sm">{String(this.state.error)}</pre>
          <button className="mt-3 px-3 py-1 bg-slate-100 rounded" onClick={() => location.reload()}>Reload</button>
        </div>
      );
    }
    return this.props.children as any;
  }
}
