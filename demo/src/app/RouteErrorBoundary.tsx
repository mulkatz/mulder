import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/components/primitives/Button';

interface RouteErrorBoundaryState {
  error: Error | null;
}

export class RouteErrorBoundary extends Component<{ children: ReactNode }, RouteErrorBoundaryState> {
  state: RouteErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): RouteErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Route render failed', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <section className="rounded-2xl border border-carmine-soft bg-carmine-faint p-8">
          <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-carmine">Renderer guard</p>
          <h1 className="mt-2 font-serif text-4xl text-ink">This route tripped, but the app stayed alive.</h1>
          <p className="mt-3 max-w-2xl text-sm text-ink-muted">{this.state.error.message}</p>
          <Button className="mt-5" onClick={() => this.setState({ error: null })}>
            Try again
          </Button>
        </section>
      );
    }

    return this.props.children;
  }
}
