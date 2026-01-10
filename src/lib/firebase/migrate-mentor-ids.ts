/**
 * Script para inicializar mentorIds en cursos existentes
 * Este script debe ejecutarse UNA VEZ para migrar los datos existentes
 *
 * Uso:
 * 1. Importar esta función en una página de admin
 * 2. Llamar a migrateMentorIds() desde un botón de admin
 * 3. Esperar a que complete
 */

import { collection, getDocs, doc, updateDoc } from "firebase/firestore";
import { db } from "./firestore";

export async function migrateMentorIds(): Promise<{ success: number; errors: number }> {
  console.log("🚀 Iniciando migración de mentorIds...");

  let successCount = 0;
  let errorCount = 0;

  try {
    // 1. Obtener todos los grupos
    const groupsSnap = await getDocs(collection(db, "groups"));
    console.log(`📦 Encontrados ${groupsSnap.size} grupos`);

    // 2. Crear un mapa de courseId -> mentorIds
    const courseMentorsMap = new Map<string, Set<string>>();

    groupsSnap.forEach((groupDoc) => {
      const data = groupDoc.data();
      const courseIds = data.courseIds ?? [];
      const assistantTeacherIds = data.assistantTeacherIds ?? [];

      if (assistantTeacherIds.length === 0) return;

      // Para cada curso en el grupo, agregar los mentores
      courseIds.forEach((courseId: string) => {
        if (!courseMentorsMap.has(courseId)) {
          courseMentorsMap.set(courseId, new Set());
        }
        assistantTeacherIds.forEach((mentorId: string) => {
          courseMentorsMap.get(courseId)!.add(mentorId);
        });
      });
    });

    console.log(`📚 Encontrados ${courseMentorsMap.size} cursos con mentores`);

    // 3. Actualizar cada curso con sus mentorIds
    for (const [courseId, mentorIdsSet] of courseMentorsMap.entries()) {
      try {
        const mentorIds = Array.from(mentorIdsSet);
        const courseRef = doc(db, "courses", courseId);

        await updateDoc(courseRef, {
          mentorIds: mentorIds,
        });

        console.log(`✅ Curso ${courseId}: ${mentorIds.length} mentor(es) agregados`);
        successCount++;
      } catch (error) {
        console.error(`❌ Error actualizando curso ${courseId}:`, error);
        errorCount++;
      }
    }

    console.log(`\n✨ Migración completada:`);
    console.log(`  ✅ Exitosos: ${successCount}`);
    console.log(`  ❌ Errores: ${errorCount}`);

    return { success: successCount, errors: errorCount };
  } catch (error) {
    console.error("❌ Error en la migración:", error);
    throw error;
  }
}

/**
 * Versión más segura que solo muestra qué cambios se harían sin aplicarlos
 */
export async function previewMentorIdsMigration(): Promise<Array<{ courseId: string; mentorIds: string[] }>> {
  const groupsSnap = await getDocs(collection(db, "groups"));
  const courseMentorsMap = new Map<string, Set<string>>();

  groupsSnap.forEach((groupDoc) => {
    const data = groupDoc.data();
    const courseIds = data.courseIds ?? [];
    const assistantTeacherIds = data.assistantTeacherIds ?? [];

    if (assistantTeacherIds.length === 0) return;

    courseIds.forEach((courseId: string) => {
      if (!courseMentorsMap.has(courseId)) {
        courseMentorsMap.set(courseId, new Set());
      }
      assistantTeacherIds.forEach((mentorId: string) => {
        courseMentorsMap.get(courseId)!.add(mentorId);
      });
    });
  });

  const preview = Array.from(courseMentorsMap.entries()).map(([courseId, mentorIdsSet]) => ({
    courseId,
    mentorIds: Array.from(mentorIdsSet),
  }));

  console.log("👀 Preview de cambios:");
  preview.forEach(({ courseId, mentorIds }) => {
    console.log(`  ${courseId}: ${mentorIds.length} mentor(es)`);
  });

  return preview;
}
