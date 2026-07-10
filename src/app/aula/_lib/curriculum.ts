import { collection, getDocs, limit, query, where } from "firebase/firestore";
import { db } from "@/lib/firebase/firestore";
import type { CurriculumCourse, FeedClass } from "./types";

/**
 * Agrupa la lista plana de clases en curso -> lección -> clases, conservando el
 * orden del feed. `index` apunta a la posición en el arreglo plano, que es lo que
 * el gating secuencial necesita.
 */
export const buildCurriculum = (
  visibleClasses: FeedClass[],
  courseTitles: Record<string, string>,
): CurriculumCourse[] => {
  const courseMap = new Map<
    string,
    {
      courseId: string;
      courseTitle: string;
      lessons: Map<string, { lessonId: string; lessonTitle: string; items: CurriculumCourse["lessons"][number]["items"] }>;
    }
  >();

  visibleClasses.forEach((cls, idx) => {
    const courseId = cls.courseId ?? "sin-curso";
    const courseTitle = courseTitles[cls.courseId ?? ""] || cls.courseTitle || "Materia";
    if (!courseMap.has(courseId)) {
      courseMap.set(courseId, { courseId, courseTitle, lessons: new Map() });
    }
    const courseEntry = courseMap.get(courseId)!;

    const lessonId = `${cls.groupId ?? "sin-grupo"}-${courseId}-${cls.lessonId ?? cls.lessonTitle ?? "leccion"}`;
    const lessonTitle = cls.lessonName ?? cls.lessonTitle ?? "Lección";
    if (!courseEntry.lessons.has(lessonId)) {
      courseEntry.lessons.set(lessonId, { lessonId, lessonTitle, items: [] });
    }
    courseEntry.lessons.get(lessonId)!.items.push({
      id: cls.id,
      title: cls.title,
      type: cls.type,
      index: idx,
    });
  });

  return Array.from(courseMap.values()).map((course) => ({
    ...course,
    lessons: Array.from(course.lessons.values()),
  }));
};

/**
 * Una clase con foro obligatorio solo se considera cumplida si el alumno ya publicó
 * (en el formato exigido, cuando el curso lo especifica).
 */
export const loadForumStatuses = async (
  uid: string,
  classes: FeedClass[],
): Promise<Record<string, boolean>> => {
  const forumClasses = classes.filter(
    (cls) => cls.forumEnabled && cls.courseId && cls.lessonId && cls.classDocId,
  );
  if (forumClasses.length === 0) return {};

  const entries = await Promise.all(
    forumClasses.map(async (cls) => {
      try {
        const constraints = [where("authorId", "==", uid)];
        if (cls.forumRequiredFormat) {
          constraints.push(where("format", "==", cls.forumRequiredFormat));
        }
        const snap = await getDocs(
          query(
            collection(
              db,
              "courses",
              cls.courseId!,
              "lessons",
              cls.lessonId!,
              "classes",
              cls.classDocId!,
              "forums",
            ),
            ...constraints,
            limit(1),
          ),
        );
        return [cls.id, !snap.empty] as const;
      } catch (err) {
        console.warn(`No se pudo verificar el foro de la clase ${cls.id}:`, err);
        return [cls.id, false] as const;
      }
    }),
  );

  return Object.fromEntries(entries);
};
