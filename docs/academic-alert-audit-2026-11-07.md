# Revisión de alertas académicas — 7 de noviembre de 2026

Consulta de solo lectura sobre Firestore. No se modificaron calificaciones,
inscripciones, cierres ni asignaciones de exámenes.

Se revisaron 1,815 inscripciones. En las inscripciones consideradas activas por
la auditoría se encontraron 1,172 cierres con nota de 49 o menos, sin una
aprobación posterior registrada para la misma materia. Corresponden a 386
alumnos. De esos cierres, 1,081 tienen actividades pendientes de calificar y
26 pertenecen a certificaciones identificadas por grupo o programa.

La presencia de pendientes no demuestra que un cierre sea incorrecto: el
docente puede cerrar una materia con actividades faltantes. Sí muestra que
una suma parcial, sin evidencia adicional, es insuficiente para anunciar una
reprobación definitiva. La ausencia de examen final configurado tampoco
permite clasificar un curso como certificación; hay materias ordinarias con
evaluación capturada por el docente.

La alerta anterior también incluía asignaciones con motivo `failed_course`
sin comprobar el cierre de la materia ni su grupo. Los adaptadores del alumno
descartaban parte de la evidencia y no llevaban la clasificación de
certificaciones a la función que arma la alerta.

La corrección aplica la misma regla en `/aula` y `/student`:

- Excluye certificaciones identificadas por grupo `CERT.`, programa, título
  o indicador explícito.
- Exige cierre y una nota válida. Una nota con pendientes o sin información
  de evaluación se muestra únicamente si existe una calificación final
  manual, un examen final presencial capturado o una calificación proveniente
  de un examen de regularización. También admite cierres sin pendientes,
  salvo que declaren cero actividades evaluables.
- Para incorporar un examen, exige una materia reprobada con evidencia en
  el mismo grupo. Una asignación sola no declara una reprobación.
- Conserva la política existente: notas de 0 a 49 generan aviso de acudir al
  coordinador; de 50 a 69 se muestran cuando hay asignación de examen por
  reprobación. Una aprobación registrada retira el aviso.

Simulación de la función corregida sobre los registros consultados:

| Métrica | Antes | Después |
| --- | ---: | ---: |
| Alumnos con aviso según los registros | 411 | 236 |
| Materias señaladas, deduplicadas por alumno | 1,203 | 305 |

En esta simulación, 175 alumnos dejan de tener aviso. Es una comparación de
registros, no de sesiones visibles ni una validación académica individual.
Los casos ambiguos se omiten del aviso; su calificación no se cambia ni se
declara aprobada. Los avisos restantes cumplen la regla de evidencia y
pueden requerir revisión académica si el alumno disputa su calificación.

La auditoría se puede repetir con `node scripts/audit-academic-alerts.cjs`;
solo imprime agregados y nombres de materias. Las pruebas de comportamiento
se ejecutan con `npm run test:academic-alert`.

La corrección está en el código local. Requiere desplegarse para cambiar el
comportamiento de la plataforma publicada. Se incrementó la versión de la
caché del aula para volver a cargar la evidencia después del despliegue.
