# Kardex de licenciatura y certificaciones

El kardex administrativo y el perfil del alumno muestran apartados independientes de **Licenciatura** y **Certificaciones**. Al abrirlos se selecciona Licenciatura. Los conteos y promedios se calculan únicamente con los registros del apartado seleccionado; el promedio general del perfil corresponde a licenciatura.

Una materia pertenece a certificaciones si el nombre de su grupo comienza con `CERT.`. La detección ignora mayúsculas y espacios al inicio o al final. Se revisan tanto el nombre del grupo actual como el nombre conservado en la inscripción histórica, para mantener la separación cuando un alumno cambia de grupo o el grupo original deja de existir. Las equivalencias conservan su identificación de procedencia; el nombre de una institución que empiece con `CERT.` no la convierte en un grupo de certificaciones.

Los usuarios que ya tienen permiso para emitir el kardex pueden descargar el PDF del apartado seleccionado. Cada documento tiene título y nombre de archivo propios. El PDF de certificaciones solo contiene registros de certificaciones y no los contabiliza dentro de las 48 asignaturas del programa de licenciatura.

La identificación de cada materia se presenta en pantalla y PDF como:

`G. LPI2024 | C. 7 | A. 12/10/26`

`C.` muestra únicamente el número registrado en el campo de cuatrimestre del grupo o la inscripción. `A.` muestra la fecha de actualización, o la de cierre si no hay actualización, en formato DD/MM/AA y zona horaria America/Monterrey. Si falta un dato se muestra `—`; no se deduce el cuatrimestre del nombre del grupo. Las equivalencias muestran su procedencia y fecha de actualización.

No se borran calificaciones ni se modifican grupos o inscripciones para aplicar esta separación. No requiere migración de datos ni índices nuevos de Firestore.
