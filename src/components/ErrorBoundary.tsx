import React from 'react';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      message: error?.message || 'Ha ocurrido un error inesperado.',
    };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#0a0e17] text-slate-100 flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-[#141c2c] border border-white/10 rounded-2xl p-8 text-center">
            <h2 className="text-xl font-bold mb-2">LettingWork</h2>
            <p className="text-sm text-slate-400 mb-6 break-words">{this.state.message}</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-cyan-400 via-blue-600 to-violet-600 text-white font-semibold text-sm hover:opacity-95 transition-opacity cursor-pointer"
            >
              Recargar página
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
