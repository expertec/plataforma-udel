# Examen final de asignatura

En el builder, agrega o edita un quiz en la semana 5 y selecciona **Tipo de evaluación → Examen final**. Su nombre es libre; escribir “Examen final” en el título no cambia un quiz semanal automáticamente.

El editor permite cargar una plantilla `.docx` con la misma estructura que los quizzes semanales. La vista previa muestra preguntas, opciones correctas y retroalimentación. Si hay varios quizzes en el archivo, se selecciona cuál utilizar. Aplicar la plantilla reemplaza los reactivos del editor; solo guardar confirma los cambios. Se conservan las explicaciones y los mensajes por opción.

## Ponderación y disponibilidad

- Un examen final por materia, con entre 1 y 200 preguntas de opción múltiple o verdadero/falso y una sola opción correcta por pregunta.
- El servidor distribuye exactamente 10 puntos entre los reactivos según sus pesos. Redondea a centésimas y reparte los centavos restantes de forma determinista. Rechaza pesos que dejarían algún reactivo sin valor.
- Los quizzes y foros restantes no pueden superar 90 puntos al configurar el examen. Al cerrar la materia, tanto manualmente como en el cierre automático, se comprueba que las demás actividades y conceptos no excedan 90 puntos. No se permite sumar además un examen final presencial manual. Una calificación final manual explícita conserva el mecanismo de excepción existente.
- Se abre 28 días después de `groups.courses[].enabledAt` para esa materia/grupo. Para grupos antiguos se utilizan `courseEnabledAt`, `startDate`, `createdAt` o la fecha de inscripción, según disponibilidad. Sin fecha válida permanece bloqueado. La fecha se muestra en horario de Monterrey.
- Un único envío por alumno y grupo, disponible hasta el cierre de la materia. Se aplica a ambas vistas del alumno y también a grupos presenciales. Las inscripciones de solo estudio no permiten evaluación.

## Compatibilidad y protección

Los quizzes existentes siguen funcionando sin cambios. Para convertir un quiz titulado “Examen final”, selecciona explícitamente el tipo de evaluación y guarda. Si ya tiene entregas, no se puede convertir para no reinterpretar calificaciones históricas.

El examen y sus preguntas se guardan en una transacción. Antes de la primera respuesta se puede sustituir la plantilla o desmarcar el examen; después, preguntas, puntajes y clasificación quedan protegidos. Desmarcar conserva los reactivos; vuelve a editar el quiz semanal para ajustar su puntuación. Al duplicar una materia se vuelve a configurar el examen final en la copia sin copiar respuestas.

El alumno recibe las preguntas a través de la API, sin respuestas correctas ni retroalimentación que revele las soluciones. La calificación se calcula exclusivamente en el servidor. En una transacción se registra el intento, la entrega calificada, el avance y el contador de intentos. Repetir una petición devuelve el mismo resultado sin duplicar puntos. Los reportes solo consideran la entrega canónica del examen final.

## Publicación

Publicar juntos la aplicación y `firestore.rules`. Las reglas bloquean la lectura directa de soluciones del examen por alumnos y las escrituras directas de configuración, reactivos, intentos y entregas finales. No requiere migración ni nuevos índices compuestos. No convierte exámenes históricos por nombre.
