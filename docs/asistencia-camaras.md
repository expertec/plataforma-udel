# Cámara en el reporte de asistencia

El reporte **Clases en vivo → acciones de la clase → Asistencia CSV** incluye tres columnas nuevas por alumno:

- **Veces que encendió la cámara:** transiciones de cámara apagada a encendida durante su participación. Volver a transmitir con cámara después de una desconexión cuenta como una nueva activación.
- **Tiempo con cámara encendida:** suma de los intervalos con cámara transmitiendo, en formato legible.
- **Segundos con cámara encendida:** el mismo tiempo en segundos para cálculos en Excel.

El valor `0` significa que se registró el estado pero el alumno no encendió la cámara. `Sin datos` indica que el registro de asistencia no contiene seguimiento de cámara, por ejemplo, en sesiones anteriores a esta función. Un alumno sin asistencia tiene cero activaciones y cero segundos.

El seguimiento observa publicaciones, retiros, silenciamiento y reactivación de la pista de cámara en LiveKit. No cuenta micrófonos, pantalla compartida ni la vista previa antes de entrar a la sala. Los cambios se envían en orden y se repite el estado cada 30 segundos para recuperar notificaciones fallidas. El contador y los intervalos se consolidan mediante transacciones; repetir el mismo estado no incrementa el contador.

Al salir o finalizar la clase se cierra cualquier intervalo de cámara abierto. Las notificaciones posteriores al cierre no vuelven a abrir el registro de cámara. El reporte limita el tiempo de cámara a la duración de la clase y al tiempo de asistencia registrado. El tiempo se calcula con las marcas de recepción del servidor, por lo que puede variar ligeramente por la latencia de red.

El alumno solo puede enviar el estado de su propia cámara con una sesión autenticada y acceso a la clase. Antes de aceptar un reporte de conexión se verifica que su identidad esté presente en la sala de LiveKit. La consulta del reporte conserva los permisos actuales de docentes, administradores y coordinación. No se almacenan imágenes ni se analiza el contenido del video para este indicador.

Los campos se guardan junto a la asistencia existente, en la subcolección `attendance` de la clase: `cameraTrackingStartedAt`, `cameraEnabled`, `cameraOnCount`, `cameraOnSeconds`, `cameraActiveStartedAt` y `cameraStateUpdatedAt`. No se necesita una migración ni índices adicionales. El seguimiento empieza con las sesiones realizadas usando la versión publicada que contiene esta función.
