'use client';

import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log del error para debugging (puedes enviar a un servicio de monitoreo)
    console.error('Error global capturado:', error);
  }, [error]);

  const isNetworkError =
    error.message?.includes('network') ||
    error.message?.includes('Network') ||
    error.message?.includes('ERR_NETWORK') ||
    error.message?.includes('Failed to fetch') ||
    error.message?.includes('firestore');

  return (
    <html lang="es">
      <body>
        <div style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#f8fafc',
          padding: '20px',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}>
          <div style={{
            maxWidth: '500px',
            width: '100%',
            textAlign: 'center',
            backgroundColor: 'white',
            borderRadius: '16px',
            padding: '40px',
            boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
          }}>
            {/* Icono */}
            <div style={{
              width: '80px',
              height: '80px',
              margin: '0 auto 24px',
              backgroundColor: isNetworkError ? '#fef3c7' : '#fee2e2',
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              {isNetworkError ? (
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2">
                  <path d="M1 1l22 22M16.72 11.06A10.94 10.94 0 0 1 19 12.55M5 12.55a10.94 10.94 0 0 1 5.17-2.39M10.71 5.05A16 16 0 0 1 22.58 9M1.42 9a15.91 15.91 0 0 1 4.7-2.88M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01"/>
                </svg>
              ) : (
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2">
                  <circle cx="12" cy="12" r="10"/>
                  <line x1="12" y1="8" x2="12" y2="12"/>
                  <line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
              )}
            </div>

            {/* Título */}
            <h1 style={{
              fontSize: '24px',
              fontWeight: '700',
              color: '#1e293b',
              marginBottom: '12px',
            }}>
              {isNetworkError ? 'Problema de conexión' : 'Algo salió mal'}
            </h1>

            {/* Descripción */}
            <p style={{
              fontSize: '16px',
              color: '#64748b',
              marginBottom: '24px',
              lineHeight: '1.5',
            }}>
              {isNetworkError
                ? 'Tu conexión a internet se interrumpió. Verifica tu conexión WiFi e intenta de nuevo.'
                : 'Ocurrió un error inesperado. No te preocupes, tus datos están seguros.'}
            </p>

            {/* Botones */}
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
            }}>
              <button
                onClick={() => reset()}
                style={{
                  width: '100%',
                  padding: '14px 24px',
                  fontSize: '16px',
                  fontWeight: '600',
                  color: 'white',
                  backgroundColor: '#3b82f6',
                  border: 'none',
                  borderRadius: '10px',
                  cursor: 'pointer',
                  transition: 'background-color 0.2s',
                }}
                onMouseOver={(e) => e.currentTarget.style.backgroundColor = '#2563eb'}
                onMouseOut={(e) => e.currentTarget.style.backgroundColor = '#3b82f6'}
              >
                Intentar de nuevo
              </button>

              <button
                onClick={() => window.location.href = '/'}
                style={{
                  width: '100%',
                  padding: '14px 24px',
                  fontSize: '16px',
                  fontWeight: '600',
                  color: '#64748b',
                  backgroundColor: '#f1f5f9',
                  border: 'none',
                  borderRadius: '10px',
                  cursor: 'pointer',
                  transition: 'background-color 0.2s',
                }}
                onMouseOver={(e) => e.currentTarget.style.backgroundColor = '#e2e8f0'}
                onMouseOut={(e) => e.currentTarget.style.backgroundColor = '#f1f5f9'}
              >
                Volver al inicio
              </button>
            </div>

            {/* Consejo */}
            {isNetworkError && (
              <div style={{
                marginTop: '24px',
                padding: '16px',
                backgroundColor: '#fffbeb',
                borderRadius: '10px',
                textAlign: 'left',
              }}>
                <p style={{
                  fontSize: '14px',
                  fontWeight: '600',
                  color: '#92400e',
                  marginBottom: '8px',
                }}>
                  Consejos:
                </p>
                <ul style={{
                  fontSize: '13px',
                  color: '#a16207',
                  paddingLeft: '20px',
                  margin: 0,
                  lineHeight: '1.6',
                }}>
                  <li>Verifica tu conexión WiFi</li>
                  <li>No cambies de pestaña mientras envías</li>
                  <li>Si usas laptop, conéctala a la corriente</li>
                </ul>
              </div>
            )}
          </div>
        </div>
      </body>
    </html>
  );
}
