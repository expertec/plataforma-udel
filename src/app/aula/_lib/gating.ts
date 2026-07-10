import type { FeedClass, ProgressSnapshot } from "./types";

export const VIDEO_COMPLETION_THRESHOLD = 80;

/** live no exige avance; image exige recorrer todas; el resto, 80%. */
export const getRequiredPct = (type?: string) => {
  if (type === "live") return 0;
  if (type === "image") return 100;
  return VIDEO_COMPLETION_THRESHOLD;
};

export const normalizeClassType = (rawType: unknown) => {
  const value = (rawType ?? "").toString().trim().toLowerCase();
  if (!value) return "video";
  if (["text", "texto", "article", "document", "doc"].includes(value)) return "text";
  if (["image", "imagen", "photo", "foto", "picture", "gallery"].includes(value)) return "image";
  if (["audio", "podcast", "sonido"].includes(value)) return "audio";
  if (["quiz", "test", "assessment", "examen"].includes(value)) return "quiz";
  if (["live", "en vivo", "envivo"].includes(value)) return "live";
  return value;
};

export const toSafeString = (value: unknown) => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
};

export const trimSafeString = (value: unknown) => toSafeString(value).trim();

/** Dentro de cada lección, las clases en vivo van primero. */
export const sortLiveClassesFirstWithinLesson = (items: FeedClass[]) => {
  const buckets = new Map<string, { live: FeedClass[]; rest: FeedClass[] }>();
  const lessonOrder: string[] = [];

  items.forEach((item) => {
    const key = `${item.groupId ?? ""}::${item.courseId ?? "__no_course__"}::${item.lessonId ?? "__no_lesson__"}`;
    if (!buckets.has(key)) {
      buckets.set(key, { live: [], rest: [] });
      lessonOrder.push(key);
    }
    const bucket = buckets.get(key)!;
    if (item.type === "live") {
      bucket.live.push(item);
      return;
    }
    bucket.rest.push(item);
  });

  const ordered: FeedClass[] = [];
  lessonOrder.forEach((key) => {
    const bucket = buckets.get(key);
    if (!bucket) return;
    ordered.push(...bucket.live, ...bucket.rest);
  });
  return ordered;
};

/** Las clases ocultas o de grupos presenciales sin tarea no se muestran al alumno. */
export const filterVisibleClasses = (classes: FeedClass[]) =>
  sortLiveClassesFirstWithinLesson(
    classes.filter((cls) => {
      if (cls.showInStudentPlatform === false) return false;
      if (cls.groupIsInPerson === true) {
        if (cls.studyOnly === true) return true;
        return cls.hasAssignment === true;
      }
      return true;
    }),
  );

export const getClassPct = (cls: FeedClass, progress: ProgressSnapshot) =>
  Math.max(
    progress.progress[cls.id] ?? 0,
    progress.completed[cls.id] || progress.seen[cls.id] ? 100 : 0,
  );

export const isForumSatisfied = (cls: FeedClass, forumDone: Record<string, boolean>) => {
  if (!cls.forumEnabled) return true;
  return forumDone[cls.id] === true;
};

export const isClassComplete = (
  cls: FeedClass,
  progress: ProgressSnapshot,
  forumDone: Record<string, boolean>,
) => getClassPct(cls, progress) >= getRequiredPct(cls.type) && isForumSatisfied(cls, forumDone);

/** La clase anterior del mismo curso: la que gobierna el desbloqueo secuencial. */
export const getPrevSameCourse = (classes: FeedClass[], targetIdx: number) => {
  const target = classes[targetIdx];
  if (!target || !target.courseId) return null;
  for (let i = targetIdx - 1; i >= 0; i -= 1) {
    if (classes[i]?.courseId === target.courseId) return classes[i];
  }
  return null;
};

/**
 * Una clase está bloqueada si la anterior de su mismo curso no se ha completado.
 * Misma regla que aplica `jumpToIndex` en el feed clásico.
 */
export const isClassLocked = (
  classes: FeedClass[],
  targetIdx: number,
  progress: ProgressSnapshot,
  forumDone: Record<string, boolean>,
) => {
  const prev = getPrevSameCourse(classes, targetIdx);
  if (!prev) return false;
  return !isClassComplete(prev, progress, forumDone);
};

export const buildLockedMessage = (cls: FeedClass) => {
  if (cls.type === "quiz") return "Completa el quiz anterior para continuar.";
  if (cls.forumEnabled) return "Participa en el foro de la clase anterior para continuar.";
  return "Completa la clase anterior para continuar.";
};

export const buildLiveClassHref = (params: {
  classId: string;
  courseId?: string;
  lessonId?: string;
}) => {
  const search = new URLSearchParams();
  if (params.courseId) search.set("courseId", params.courseId);
  if (params.lessonId) search.set("lessonId", params.lessonId);
  const qs = search.toString();
  return `/live/${encodeURIComponent(params.classId)}${qs ? `?${qs}` : ""}`;
};
