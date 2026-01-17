'use client';

import { useEffect } from 'react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Error capturado:', error);
  }, [error]);

  const isNetworkError =
    error.message?.includes('network') ||
    error.message?.includes('Network') ||
    error.message?.includes('ERR_NETWORK') ||
    error.message?.includes('Failed to fetch') ||
    error.message?.includes('firestore') ||
    error.message?.includes('QUIC') ||
    error.message?.includes('WebChannel');

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-5">
      <div className="max-w-md w-full text-center bg-white rounded-2xl p-10 shadow-lg">
        {/* Icono */}
        <div className={`w-20 h-20 mx-auto mb-6 rounded-full flex items-center justify-center ${
          isNetworkError ? 'bg-amber-100' : 'bg-red-100'
        }`}>
          {isNetworkError ? (
            <svg className="w-10 h-10 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 2.829a5 5 0 01-7.072-7.072m7.072 7.072L6.343 17.657M8.464 8.464a5 5 0 00-7.072 7.072m7.072-7.072L3 3m5.464 5.464l9.072 9.072" />
            </svg>
          ) : (
            <svg className="w-10 h-10 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          )}
        </div>

        {/* Título */}
        <h2 className="text-2xl font-bold text-slate-800 mb-3">
          {isNetworkError ? 'Problema de conexión' : 'Algo salió mal'}
        </h2>

        {/* Descripción */}
        <p className="text-slate-500 mb-6 leading-relaxed">
          {isNetworkError
            ? 'Tu conexión a internet se interrumpió. Verifica tu conexión WiFi e intenta de nuevo.'
            : 'Ocurrió un error inesperado. No te preocupes, tus datos están seguros.'}
        </p>

        {/* Botones */}
        <div className="flex flex-col gap-3">
          <button
            onClick={() => reset()}
            className="w-full py-3.5 px-6 text-base font-semibold text-white bg-blue-500 hover:bg-blue-600 rounded-xl transition-colors"
          >
            Intentar de nuevo
          </button>

          <button
            onClick={() => window.location.reload()}
            className="w-full py-3.5 px-6 text-base font-semibold text-slate-500 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors"
          >
            Recargar página
          </button>
        </div>

        {/* Consejos para error de red */}
        {isNetworkError && (
          <div className="mt-6 p-4 bg-amber-50 rounded-xl text-left">
            <p className="text-sm font-semibold text-amber-800 mb-2">
              Consejos:
            </p>
            <ul className="text-sm text-amber-700 pl-5 list-disc space-y-1">
              <li>Verifica tu conexión WiFi</li>
              <li>No cambies de pestaña mientras envías</li>
              <li>Si usas laptop, conéctala a la corriente</li>
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
