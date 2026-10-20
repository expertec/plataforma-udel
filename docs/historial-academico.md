# Historial académico de captura manual

Los administradores (`adminTeacher` y `superAdminTeacher`) pueden registrar materias cursadas en UDEL que no están en la plataforma desde **Alumnos → menú del alumno → Historial académico (captura manual)**. Aplica tanto a expedientes anteriores a 2026 como a materias omitidas después de la implementación de la plataforma.

## Captura

Se puede seleccionar una materia del catálogo (incluidas materias archivadas) o escribir su nombre histórico. El grupo se puede seleccionar de la lista existente o escribir manualmente, sin crear un grupo. Materia, grupo, ciclo escolar, cuatrimestre, apartado, tipo de acreditación, calificación y fecha de registro son obligatorios; las observaciones son opcionales. El ciclo escolar es un texto independiente del número de cuatrimestre.

Los apartados disponibles son Licenciatura y Certificaciones. La selección explícita determina el apartado del registro manual, incluso si el nombre de un grupo histórico comienza con `CERT.`. Las inscripciones de plataforma y las equivalencias conservan sus reglas de clasificación existentes.

Los tipos de acreditación son Ordinario, Extraordinario y Global. Se aceptan calificaciones de 0 a 10 o de 0 a 100, incluidas reprobatorias y cero. Se conservan la escala y nota originales y se normaliza la nota final a escala de 100 con un decimal. Una captura guarda un resultado final por materia, grupo y ciclo; para corregir el resultado o tipo de acreditación de ese mismo intento se utiliza **Corregir**.

Se agregan hasta 40 materias a una lista que puede revisarse antes de guardar. La lista se guarda completa o ninguna materia se guarda. Después de agregar una materia se conservan los datos de grupo, ciclo, cuatrimestre, apartado, tipo de acreditación, escala y fecha para facilitar la captura del expediente.

## Captura desde Excel

En el mismo apartado, **Descargar plantilla Excel** genera un archivo con las hojas Materias, Instrucciones, Ejemplo, Catálogo y Grupos. La hoja Materias comienza vacía; los ejemplos e instrucciones están separados y nunca se importan. La descarga desde la plataforma incluye los identificadores y nombres del catálogo y grupos disponibles. También existe una [plantilla genérica](../public/plantillas/plantilla-historial-academico.xlsx) sin esos datos de referencia.

Completa la hoja **Materias** desde la fila 2 para el alumno cuyo historial está abierto. Incluye materia, grupo, ciclo escolar, cuatrimestre, apartado, tipo de acreditación, calificación, escala y fecha de registro. Observaciones, ID materia e ID grupo son opcionales. Se aceptan archivos `.xlsx` y `.xls` de hasta 5 MB y un máximo de 40 materias por lote, incluyendo las que ya están en la lista por guardar.

**Importar Excel** valida todas las filas antes de agregarlas a la lista. Si encuentra un error, muestra su número de fila y no agrega ninguna materia del archivo. Los duplicados se revisan contra el propio archivo, la lista pendiente y el historial manual vigente. Al guardar se aplican además todas las validaciones del servidor, incluidos los conflictos con equivalencias y calificaciones de plataforma.

Una coincidencia única de nombre con el catálogo o los grupos se vincula automáticamente. Si hay varios registros con el mismo nombre, se debe indicar su ID desde la hoja de referencia. Un nombre que no existe y no tiene ID se conserva como nombre histórico; la lista indica cuáles materias quedaron vinculadas al catálogo y cuáles no. Los identificadores inexistentes o que no corresponden al nombre se rechazan.

Se aceptan fechas de Excel, texto `DD/MM/AAAA` y texto `AAAA-MM-DD`, con soporte para el calendario de Excel de 1904. También se admite el prefijo `M-`; la plataforma lo presenta automáticamente en el kárdex. No se aceptan fórmulas ni celdas con errores en la captura: se deben reemplazar por valores. La importación no guarda cambios por sí sola; se debe revisar la lista y pulsar **Guardar registros académicos en el kardex**.

## Kárdex y fecha manual

Los registros vigentes aparecen identificados como **Captura manual** en el kárdex administrativo, el perfil del alumno y el PDF institucional del apartado correspondiente. La identificación muestra grupo, ciclo, cuatrimestre, tipo de acreditación y fecha:

`G. LPI2023 | Ciclo: 2024-2 | C. 4 | Extraordinario | M-17/10/2026`

La fecha se selecciona con el control de fecha y el prefijo `M-` se agrega automáticamente. Se almacena como fecha de calendario (`YYYY-MM-DD`), separada de la fecha real de creación y actualización. Corregir otro dato no cambia la fecha del kárdex. Las fechas de auditoría se generan en el servidor y la administración las presenta en la zona America/Monterrey.

En el PDF, la nota manual se coloca únicamente en la columna del tipo de acreditación seleccionado. En las pantallas se conserva la nota final y, cuando corresponde, la nota de extraordinario o global. Los datos históricos de grupo, materia y cuatrimestre se conservan aunque el catálogo o grupo cambie posteriormente.

Los registros manuales participan en el promedio del apartado, incluyendo reprobatorias y recursamientos, como las demás filas cerradas con nota. Para el avance del programa solo cuentan las materias aprobadas vinculadas al catálogo; cada identificador de materia cuenta una sola vez. Las materias escritas sin vinculación aparecen en el historial y promedio pero no acreditan una asignatura del catálogo. Certificaciones no suma a las 48 asignaturas del programa.

## Conflictos, correcciones y anulaciones

- Se rechazan duplicados de la misma materia, grupo, ciclo y apartado, usando identificadores o nombres normalizados sin distinguir acentos, mayúsculas ni espacios adicionales.
- Se permiten recursamientos en otro grupo o ciclo. No se sobrescriben las calificaciones de las inscripciones.
- Se rechaza una captura que ya tiene historial de plataforma en el mismo grupo y apartado. Si la inscripción o grupo tiene ciclo, se compara ese ciclo; si no lo tiene, se rechaza el conflicto de grupo y materia para revisión del expediente.
- Una equivalencia vigente impide capturar la misma materia manualmente en Licenciatura. A su vez, una captura manual vigente de Licenciatura impide registrar una equivalencia de esa materia. Certificaciones se trata por separado.
- Corregir y anular requieren motivo. Se verifica la versión del registro para evitar que una captura desactualizada sobrescriba cambios de otro administrador.
- Anular conserva el registro y la auditoría, pero lo excluye del kárdex, PDF y promedio. La lista administrativa incluye anulaciones.

La captura no crea inscripciones ni acceso a contenidos, tareas o asistencia.

## Almacenamiento y acceso

- `studentAcademicHistory`: registros independientes de las inscripciones.
- `studentAcademicHistory/{id}/history`: versión anterior, posterior, acción, responsable, motivo y fecha real de cada cambio.
- `studentEquivalencyLocks/{studentId}`: bloqueo transaccional compartido con equivalencias para serializar capturas concurrentes.
- `GET /api/students/{studentId}/academic-history`: registros vigentes para el propio alumno, administradores y coordinación/dirección dentro del alcance de plantel. Solo administradores pueden incluir anulaciones con `?history=1`.
- `POST /api/students/{studentId}/academic-history`: `{ entries: AcademicHistoryInput[] }`, solo administradores.
- `PATCH /api/students/{studentId}/academic-history`: `{ action: "update", id, version, entry, reason }` o `{ action: "cancel", id, version, reason }`, solo administradores.

Firebase Admin verifica la sesión y permisos en el servidor. Coordinación/dirección necesita compartir un plantel actual o histórico con el alumno y solo recibe registros de sus planteles. La captura de grupo existente toma el plantel del grupo; un grupo escrito manualmente toma los planteles actuales del alumno. El docente conserva su consulta habitual de calificaciones de grupo.

Firestore deniega el acceso directo del cliente a los registros y su auditoría. No se requiere migrar expedientes ni crear índices compuestos. La publicación debe incluir el código y las reglas de Firestore. Los registros aparecen al volver a abrir el kárdex o recargar el perfil.

## Verificación

`npm run test:academic-history`

Las pruebas ejecutan los modelos, servicios del servidor y rutas reales con Firestore aislado. Cubren escalas, fechas, acreditación, promedios y avance, permisos, alcance de planteles, captura atómica, duplicados, recursamientos, conflictos con equivalencias, correcciones, anulaciones y conservación de datos históricos. También verifican la plantilla y su lectura desde bytes reales de Excel, fechas, nombres e identificadores, errores por fila, fórmulas y límites de importación.
