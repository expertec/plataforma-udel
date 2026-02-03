"use client";

import React, { Component, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  retryCount: number;
  isRetrying: boolean;
}

const MAX_AUTO_RETRIES = 3;
const RETRY_DELAY_MS = 1500;

export default class StudentFeedErrorBoundary extends Component<Props, State> {
  private retryTimeout: NodeJS.Timeout | null = null;

  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, retryCount: 0, isRetrying: false };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.warn("Error en la vista del estudiante:", error, errorInfo);

    // Auto-reintentar si no hemos excedido el límite
    if (this.state.retryCount < MAX_AUTO_RETRIES) {
      this.scheduleRetry();
    }
  }

  componentWillUnmount() {
    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout);
    }
  }

  scheduleRetry = () => {
    this.setState({ isRetrying: true });
    this.retryTimeout = setTimeout(() => {
      this.setState((prev) => ({
        hasError: false,
        error: null,
        retryCount: prev.retryCount + 1,
        isRetrying: false,
      }));
    }, RETRY_DELAY_MS);
  };

  handleManualRetry = () => {
    this.setState({ hasError: false, error: null, retryCount: 0, isRetrying: false });
  };

  render() {
    // Mostrar indicador de carga mientras reintenta automáticamente
    if (this.state.isRetrying) {
      return (
        <div className="min-h-screen bg-gray-900 flex items-center justify-center">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4"></div>
            <p className="text-gray-400">Reconectando...</p>
          </div>
        </div>
      );
    }

    // Solo mostrar error si excedimos los reintentos automáticos
    if (this.state.hasError && this.state.retryCount >= MAX_AUTO_RETRIES) {
      return (
        <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
          <div className="bg-gray-800 rounded-lg p-8 max-w-md w-full text-center">
            <h2 className="text-white text-xl font-semibold mb-2">
              Problema de conexión
            </h2>
            <p className="text-gray-400 mb-6">
              Hubo un problema al cargar tus clases. Verifica tu conexión a internet e intenta de nuevo.
            </p>
            <button
              onClick={this.handleManualRetry}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 px-4 rounded-lg transition-colors"
            >
              Reintentar
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
