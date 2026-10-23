# Equivalencias

Los administradores (`adminTeacher` y `superAdminTeacher`), directores (`director`) y coordinadores (`coordinadorPlantel`) pueden registrar equivalencias desde **Alumnos → menú del alumno → Equivalencias**. Dirección y coordinación solo consultan registros vigentes y agregan materias dentro del alcance de sus planteles; las correcciones y anulaciones corresponden a administradores. Se pueden buscar materias del catálogo o escribir sus nombres, capturar hasta 40 materias y guardarlas juntas. La institución de procedencia, periodo y observaciones son opcionales; la calificación y fecha de reconocimiento son obligatorias.

Se aceptan notas aprobatorias de 7 a 10 o de 70 a 100, según la escala elegida. Todas se almacenan en escala de 100 con un decimal: 8.5/10 equivale a 85/100. La captura conserva la nota y escala originales. Esta escala coincide con la captura actual de calificaciones; el kardex institucional usa 70 como mínimo aprobatorio.

Las equivalencias vigentes aparecen identificadas en el kardex administrativo, el kardex del alumno y el PDF institucional, y participan en el promedio. Las materias manuales cuentan como historial y promedio; únicamente las vinculadas al catálogo participan en el conteo de asignaturas del programa. La equivalencia no crea una materia del catálogo ni una inscripción, y no concede acceso a contenidos ni genera tareas o asistencia. La carga del alumno se administra por separado.

La captura rechaza duplicados por identificador de materia o nombre normalizado, incluso dentro de una misma lista. También rechaza materias ya inscritas o con historial de calificaciones. Un conflicto requiere revisar la carga e historial del alumno; no se sustituyen calificaciones existentes. La lista se guarda completa o no se guarda ninguna materia.

También se rechazan materias con [historial académico manual](historial-academico.md) vigente en Licenciatura. Ambas capturas comparten el bloqueo transaccional por alumno para evitar conflictos concurrentes. Los registros manuales de Certificaciones no impiden registrar equivalencias de Licenciatura.

Las correcciones y anulaciones requieren motivo. Anular conserva el registro pero lo excluye del kardex y el promedio. Cada cambio conserva una versión anterior y posterior, responsable, fecha y motivo en `studentEquivalencies/{id}/history`. La lista administrativa incluye los registros anulados.

## Almacenamiento y acceso

- `studentEquivalencies`: registros independientes de grupos e inscripciones.
- `studentEquivalencyLocks`: serialización de cambios por alumno mediante transacciones.
- `GET /api/students/{studentId}/equivalencies`: equivalencias vigentes para el propio alumno, administradores y coordinación/dirección con alcance de plantel. Los administradores pueden usar `?history=1` para incluir anulaciones.
- `POST /api/students/{studentId}/equivalencies`: `{ entries: EquivalencyInput[] }`, administradores y coordinación/dirección con alcance de plantel.
- `PATCH /api/students/{studentId}/equivalencies`: `{ action: "update", id, version, entry, reason }` o `{ action: "cancel", id, version, reason }`, solo administradores.

Los permisos y datos se validan en el servidor con Firebase Admin. Coordinación y dirección solo leen equivalencias registradas en sus planteles y de alumnos dentro de su alcance actual o histórico, como en la consulta existente de calificaciones. Para agregar materias se exige compartir al menos un plantel actual o histórico con el alumno. La equivalencia nueva se asigna únicamente a los planteles compartidos, sin conceder visibilidad a otros planteles del alumno. Sin plantel asignado no se permite capturar. El docente conserva su consulta habitual de calificaciones de grupo. Las colecciones de equivalencias y auditoría no se exponen directamente al cliente en las reglas de Firestore.

No se necesita migrar inscripciones existentes ni crear índices compuestos. Al publicar se deben incluir las nuevas rutas, componentes y reglas de Firestore del repositorio. Los registros nuevos empiezan a aparecer al volver a abrir el kardex o recargar el perfil del alumno.
