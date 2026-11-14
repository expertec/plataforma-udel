# Materiales en clases en vivo

El profesor abre **Materiales de la clase** en la sala de preparación, o **Materiales** en la barra de la videollamada. La biblioteca pertenece a la clase y conserva los archivos y enlaces entre sesiones. Se pueden buscar, presentar y eliminar hasta 50 materiales.

**Subir archivo** abre un selector que permite elegir varios archivos a la vez. Se cargan en orden y se agregan a los materiales existentes; un archivo que falle no impide cargar los siguientes. Subir archivo, Pegar enlace y Cerrar están únicamente en el encabezado del panel, que permanece visible mientras se desplaza la lista. El panel de preparación se ajusta al área visible de la pantalla, incluido el zoom. También se puede cerrar con Escape.

La preparación de cámara y la biblioteca comparten un contenedor que ocupa el área visible. En escritorio aparecen una junto a la otra, con desplazamiento independiente. En móvil se alterna entre cámara y materiales mediante el botón de la barra superior. La cámara conserva su proporción y los controles inferiores siguen accesibles al desplazarse dentro de su área.

Durante la presentación de materiales o pantalla compartida, las cámaras aparecen arriba en una fila horizontal de 96 px de altura, con miniaturas fijas de 160 × 90 px. Estas dimensiones y la distribución se aplican directamente al componente para que no dependan de las hojas de estilo globales ni del carrusel de LiveKit. Si hay muchos participantes, esa fila se desplaza horizontalmente. El contenido compartido ocupa el espacio restante debajo y los controles de llamada conservan su espacio al pie. Las pistas de pantalla compartida no se incluyen entre las cámaras de la fila.

## Formatos

| Material | Presentación | Límite por archivo |
| --- | --- | --- |
| PDF | Visor PDF.js; el profesor cambia de página | 20 MB |
| Word `.docx` | Texto dividido en secciones sincronizadas | 10 MB y 200 000 caracteres |
| PowerPoint `.pptx` | Diapositivas estáticas; el profesor controla el avance | 50 MB, 300 diapositivas y 100 MB descomprimidos |
| JPEG, PNG, WebP, GIF | Imagen en el escenario | 20 MB |
| MP4, WebM | Video con reproducción, pausa y búsqueda controladas por el profesor | 200 MB |
| YouTube | Reproductor insertado a partir de un enlace válido | Sin carga de archivo |
| Google Sheets, Slides, Docs y archivos de Drive | Visor de Google a partir de un enlace compartido o publicado | Sin copiar ni cargar el archivo |

Word se presenta como texto: tablas, imágenes y formato no se conservan. Para presentar el diseño original se debe exportar a PDF. Los `.doc` antiguos deben convertirse a `.docx` o PDF. En videos se recomienda MP4 con H.264/AAC para compatibilidad entre navegadores. YouTube debe permitir la inserción; sus anuncios, restricciones regionales o disponibilidad pueden afectar la sincronización. Cada participante puede silenciar el material localmente. Si el navegador bloquea la reproducción automática, aparece un botón para activarla.

PowerPoint se muestra mediante un visor local en el navegador, sin enviar el archivo a servicios de conversión externos. Conserva el orden de la presentación y sincroniza la diapositiva seleccionada. Las animaciones, transiciones, videos incrustados y algunos elementos complejos (gráficos, SmartArt o fuentes no instaladas) no se reproducen con la misma fidelidad que PowerPoint. Para conservar el diseño visual, exportar a PDF. Los `.ppt` antiguos deben convertirse a `.pptx` o PDF.

## Enlaces de Google

En **Pegar enlace**, introducir el enlace de Sheets, Slides, Docs o de un archivo de Drive, agregar un nombre opcional y guardar. El tipo se detecta automáticamente; también se siguen admitiendo enlaces de YouTube en el mismo formulario. Al pulsar Presentar, el visor aparece debajo de las cámaras.

Se aceptan enlaces normales de compartir, enlaces publicados (`/d/e/...`) y enlaces de archivo de Drive (`/file/d/...` u `/open?id=...`). Se conserva la pestaña `gid` de Sheets, la diapositiva inicial de Slides y `resourcekey` cuando el archivo lo requiere. Los enlaces de carpetas y de sitios arbitrarios se rechazan. El servidor guarda únicamente un enlace canónico; no cambia permisos ni descarga una copia del documento.

**Los alumnos deben tener acceso al archivo en Google.** Las restricciones del propietario o de Google Workspace, el inicio de sesión y las cookies del navegador pueden impedir mostrarlo dentro de un iframe. En ese caso se puede abrir con **Abrir en Google**, o usar el enlace publicado mediante Archivo → Compartir → Publicar en la Web cuando esté permitido. La opción y sus efectos se describen en la [ayuda oficial de Google](https://support.google.com/docs/answer/183965). La aplicación no publica archivos automáticamente.

El inicio y fin de la presentación del archivo se comparten con la clase. **La navegación interna del iframe de Google es individual:** desplazamientos, celdas, pestañas y cambios de diapositiva realizados dentro del visor no se sincronizan con otros participantes. Para mostrar exactamente esa navegación, compartir la pestaña mediante la opción de pantalla de la videollamada; para Slides también se puede exportar a PDF o PPTX y usar el avance sincronizado de materiales.

## Persistencia y sincronización

- `/api/live/classes/[classId]/materials` usa el token de Firebase y la autorización existente de la clase, incluidos `courseId` y `lessonId` para clases legacy.
- Solo los docentes autorizados pueden cargar, agregar enlaces, presentar, controlar o eliminar. Los alumnos reciben únicamente el material activo, sin la biblioteca privada del docente.
- Firestore guarda la biblioteca en `liveMaterials` y el estado actual en `liveMaterialState/current`, dentro del documento de clase. El acceso se realiza mediante Firebase Admin, sin abrir reglas de lectura/escritura del cliente.
- La presentación pertenece a `liveSession.lastStartedAt`. Una sesión nueva no reproduce automáticamente una presentación anterior. La biblioteca sí se conserva.
- El estado contiene página, posición, reproducción, hora del servidor y revisión. Los controles de una revisión anterior se rechazan para evitar que sobrescriban cambios posteriores.
- LiveKit transmite avisos de cambio, y los clientes consultan el estado autorizado. Una consulta cada ocho segundos recupera avisos perdidos. Los alumnos que entran tarde recuperan el material y la posición actuales; los relojes locales se ajustan con la hora del servidor.

## Almacenamiento

Se usa el bucket existente de `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`, `FIREBASE_STORAGE_BUCKET` o la configuración de Firebase Admin. El servidor crea una sesión de carga reanudable de GCS con tipo y tamaño esperados; el navegador envía el archivo directamente al almacenamiento, sin pasar videos grandes por el cuerpo de una función de Next.js. Tras la carga, el servidor verifica tamaño, MIME y firma del archivo antes de publicar el material. Word se procesa en el servidor con Mammoth.

Los objetos usan `live-materials/{courseId}/{lessonId}/{classId}/{materialId}/source` y enlaces de descarga con token aleatorio. Son enlaces de acceso por posesión: un participante que copie el enlace puede reutilizarlo mientras exista el archivo. Al eliminar se solicita borrar el objeto; los errores de limpieza se registran en el servidor. Las cargas abandonadas no se muestran y dejan de reservar un lugar en la biblioteca después de 24 horas; la limpieza física de cargas abandonadas requiere una política de mantenimiento del bucket.

PPTX se valida como paquete Office con JSZip antes de publicarlo. Se comprueba que incluya presentación, relaciones y diapositivas, y se limita el tamaño descomprimido antes de extraer contenido. El cliente utiliza `pptx-react-renderer` cargado bajo demanda y sanea el HTML de cada diapositiva con DOMPurify; solo se monta la diapositiva activa. La revisión de presentación y el límite de diapositivas también se verifican al recibir controles del profesor.

## Grabación

El material se muestra en los clientes de la clase. **No se incorpora automáticamente a la grabación compuesta actual de LiveKit**, que graba las pistas de audio/video y pantalla compartida. Incluir este visor y su audio en esa grabación requiere una plantilla de grabación adicional. Esta implementación no cambia el sistema de grabación.

## Validación

`npm run test:live-materials` prueba enlaces, formatos y tamaños, paginación Word, tiempo de reproducción, permisos, acceso del alumno, separación de sesiones, controles obsoletos, preparación, eliminación, cargas incompletas, verificación del archivo y límite de biblioteca. Las pruebas de rutas usan dobles de Firebase/GCS; no modifican datos reales.

Antes de usarlo en producción, comprobar una clase con dos cuentas reales: carga contra el bucket configurado, actualización por LiveKit, recuperación al reconectar, audio en móviles y reproducción de los enlaces de YouTube elegidos.
