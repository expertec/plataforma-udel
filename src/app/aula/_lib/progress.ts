import { collection, doc, getDocs, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/firestore";
import { VIDEO_COMPLETION_THRESHOLD } from "./gating";
import type { ProgressSnapshot } from "./types";

/**
 * Misma clave que usa el feed clásico. Compartirla es lo que hace que el avance
 * hecho en /aula aparezca en /feed sin recargar nada.
 */
const localProgressKey = (uid: string) => `classProgress:${uid}`;

const emptySnapshot = (): ProgressSnapshot => ({ progress: {}, completed: {}, seen: {} });

export const loadLocalProgress = (uid: string): ProgressSnapshot => {
  if (typeof window === "undefined") return emptySnapshot();
  try {
    const raw = localStorage.getItem(localProgressKey(uid));
    if (!raw) return emptySnapshot();
    const parsed = JSON.parse(raw);
    return {
      progress: parsed.progress ?? {},
      completed: parsed.completed ?? {},
      seen: parsed.seen ?? {},
    };
  } catch {
    return emptySnapshot();
  }
};

export const saveLocalProgress = (uid: string, data: ProgressSnapshot) => {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(localProgressKey(uid), JSON.stringify(data));
  } catch {
    // localStorage puede fallar en modo incógnito; el progreso ya viaja a Firestore.
  }
};

/** Respaldo de "visto" en users/{uid}/seenClasses/{classId}. */
const saveSeenForUser = async (uid: string, classId: string, progress: number, completed: boolean) => {
  try {
    await setDoc(
      doc(db, "users", uid, "seenClasses", classId),
      {
        seen: completed || progress >= VIDEO_COMPLETION_THRESHOLD,
        progress: Math.max(progress, completed ? 100 : progress),
        updatedAt: new Date(),
      },
      { merge: true },
    );
  } catch (err) {
    if ((err as { code?: string })?.code !== "permission-denied") {
      console.warn("No se pudo guardar seenClasses:", err);
    }
  }
};

/**
 * Fusiona las tres fuentes de progreso (localStorage, users/{uid}/seenClasses y
 * studentEnrollments/{id}/classProgress) con la misma precedencia que el feed clásico:
 * un "seen" o un avance >= 80 cuentan como completado.
 */
export const loadProgressFromFirestore = async (
  uid: string,
  enrollmentIds: string[],
): Promise<ProgressSnapshot> => {
  const local = loadLocalProgress(uid);
  const loadedProgress: Record<string, number> = { ...local.progress };
  const loadedCompleted: Record<string, boolean> = { ...local.completed };
  const loadedSeen: Record<string, boolean> = { ...local.seen };

  // seenClasses y el progreso de cada enrollment se leen a la vez.
  const [seenDocs, enrollmentProgressDocs] = await Promise.all([
    getDocs(collection(db, "users", uid, "seenClasses"))
      .then((snap) => snap.docs)
      .catch((err) => {
        console.warn("No se pudo leer seenClasses, se continúa con enrollment/local:", err);
        return [];
      }),
    Promise.all(
      enrollmentIds.map((enrollmentId) =>
        getDocs(collection(db, "studentEnrollments", enrollmentId, "classProgress"))
          .then((snap) => snap.docs)
          .catch((err) => {
            console.warn(`No se pudo cargar progreso del enrollment ${enrollmentId}:`, err);
            return [];
          }),
      ),
    ),
  ]);

  seenDocs.forEach((docSeen) => {
    const data = docSeen.data();
    const seen = Boolean(data.seen);
    const progress = data.progress ?? 0;
    loadedSeen[docSeen.id] = loadedSeen[docSeen.id] || seen;
    loadedCompleted[docSeen.id] =
      loadedCompleted[docSeen.id] || seen || progress >= VIDEO_COMPLETION_THRESHOLD;
    if (seen) {
      loadedProgress[docSeen.id] = Math.max(loadedProgress[docSeen.id] ?? 0, progress, 100);
    }
  });

  enrollmentProgressDocs.flat().forEach((progressDoc) => {
    const data = progressDoc.data();
    const id = progressDoc.id;
    const completed = Boolean(data.completed);
    const seen = Boolean(data.seen) || completed;
    const progress = data.progress ?? 0;
    const mergedSeen = seen || loadedSeen[id] || progress >= VIDEO_COMPLETION_THRESHOLD;
    const mergedCompleted = completed || loadedCompleted[id] || mergedSeen;
    loadedSeen[id] = mergedSeen;
    loadedCompleted[id] = mergedCompleted;
    loadedProgress[id] = mergedSeen
      ? Math.max(100, loadedProgress[id] ?? 0)
      : Math.max(progress, loadedProgress[id] ?? 0);
  });

  const snapshot: ProgressSnapshot = {
    progress: loadedProgress,
    completed: loadedCompleted,
    seen: loadedSeen,
  };
  saveLocalProgress(uid, snapshot);
  return snapshot;
};

export type SaveProgressResult = {
  storedProgress: number;
  completed: boolean;
  justCompleted: boolean;
};

/**
 * Escribe en studentEnrollments/{enrollmentId}/classProgress/{classId} — el mismo
 * documento que lee y escribe el feed clásico. Nunca reduce el máximo alcanzado.
 */
export const saveProgressToFirestore = async (params: {
  uid: string;
  enrollmentId: string;
  classId: string;
  progress: number;
  previousProgress: number;
  requiredPct: number;
  alreadySeen?: boolean;
}): Promise<SaveProgressResult | null> => {
  const { uid, enrollmentId, classId, progress, previousProgress, requiredPct } = params;
  if (!uid || !enrollmentId) return null;

  const newProgress = Math.max(progress, previousProgress);
  const completed = newProgress >= requiredPct;
  const justCompleted = previousProgress < requiredPct && completed;
  const storedProgress = completed ? Math.max(newProgress, 100) : newProgress;

  try {
    await setDoc(
      doc(db, "studentEnrollments", enrollmentId, "classProgress", classId),
      {
        progress: storedProgress,
        lastUpdated: new Date(),
        completed,
        seen: completed || params.alreadySeen === true,
        ...(justCompleted ? { completedAt: new Date() } : {}),
      },
      { merge: true },
    );

    const local = loadLocalProgress(uid);
    saveLocalProgress(uid, {
      progress: { ...local.progress, [classId]: storedProgress },
      completed: { ...local.completed, [classId]: completed || local.completed[classId] === true },
      seen: { ...local.seen, [classId]: completed || local.seen[classId] === true },
    });

    await saveSeenForUser(uid, classId, storedProgress, completed || justCompleted);
    return { storedProgress, completed, justCompleted };
  } catch (error) {
    console.error("Error guardando progreso:", error);
    return null;
  }
};

/** Marcado manual: fija 100% y deja rastro de que lo pidió el alumno. */
export const markClassCompletedManually = async (params: {
  uid: string;
  enrollmentId: string;
  classId: string;
}) => {
  const { uid, enrollmentId, classId } = params;
  if (!uid || !enrollmentId) return false;
  try {
    await setDoc(
      doc(db, "studentEnrollments", enrollmentId, "classProgress", classId),
      {
        progress: 100,
        lastUpdated: new Date(),
        completed: true,
        seen: true,
        manuallyCompleted: true,
        completedAt: new Date(),
      },
      { merge: true },
    );
    const local = loadLocalProgress(uid);
    saveLocalProgress(uid, {
      progress: { ...local.progress, [classId]: 100 },
      completed: { ...local.completed, [classId]: true },
      seen: { ...local.seen, [classId]: true },
    });
    await saveSeenForUser(uid, classId, 100, true);
    return true;
  } catch (error) {
    console.error("Error marcando la clase como completada:", error);
    return false;
  }
};
