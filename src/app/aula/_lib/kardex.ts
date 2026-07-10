import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/lib/firebase/firestore";
import { trimSafeString } from "./gating";

export type KardexRow = {
  id: string;
  groupId: string;
  groupName: string;
  courseId: string;
  courseName: string;
  status: "open" | "closed";
  finalGrade: number | null;
  autoGrade: number | null;
  pendingUngradedCount: number | null;
  closedAt: Date | null;
  updatedAt: Date | null;
  archived: boolean;
};

const toDateOrNull = (value: unknown): Date | null => {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (
    typeof value === "object" &&
    value !== null &&
    "toDate" in value &&
    typeof (value as { toDate?: unknown }).toDate === "function"
  ) {
    try {
      const parsed = (value as { toDate: () => Date }).toDate();
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    } catch {
      return null;
    }
  }
  return null;
};

const toNumberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** Un id de Firestore no sirve como nombre de materia. */
const looksLikeFirestoreId = (value: string) => /^[A-Za-z0-9_-]{16,}$/.test(value.trim());

const rowKey = (groupId: string, courseId: string) => `${groupId}::${courseId}`;

const rowTimestamp = (row: KardexRow) =>
  Math.max(row.closedAt?.getTime() ?? 0, row.updatedAt?.getTime() ?? 0);

/**
 * El kardex se arma con el mapa `courseClosures` de cada inscripción, igual que el
 * kardex del panel docente (StudentGradesModal). Se incluyen las inscripciones
 * archivadas para conservar las materias de grupos anteriores.
 */
export const loadKardex = async (
  uid: string,
  courseTitles: Record<string, string>,
): Promise<KardexRow[]> => {
  const [liveDocs, archivedDocs] = await Promise.all([
    getDocs(query(collection(db, "studentEnrollments"), where("studentId", "==", uid)))
      .then((snap) => snap.docs)
      .catch((err) => {
        console.warn("No se pudieron leer las inscripciones para el kardex:", err);
        return [];
      }),
    getDocs(query(collection(db, "studentEnrollmentsArchive"), where("studentId", "==", uid)))
      .then((snap) => snap.docs)
      .catch((err) => {
        console.warn("No se pudo leer el historial de inscripciones:", err);
        return [];
      }),
  ]);

  const rows = new Map<string, KardexRow>();

  const upsert = (row: KardexRow) => {
    const previous = rows.get(row.id);
    // Ante duplicados (misma materia en inscripción viva y archivada) gana la más
    // reciente; y a igualdad, la viva, que se ingiere después.
    if (!previous || rowTimestamp(row) >= rowTimestamp(previous)) rows.set(row.id, row);
  };

  const resolveCourseName = (courseId: string, fallback: string) => {
    const fromTitles = trimSafeString(courseTitles[courseId]);
    if (fromTitles) return fromTitles;
    const fromEnrollment = trimSafeString(fallback);
    if (fromEnrollment) return fromEnrollment;
    if (!courseId) return "Sin materia";
    return looksLikeFirestoreId(courseId) ? "Materia archivada" : courseId;
  };

  const ingest = (data: Record<string, unknown>, archived: boolean) => {
    const groupId = trimSafeString(data.groupId);
    const groupName = trimSafeString(data.groupName) || "Grupo";
    const fallbackCourseName = trimSafeString(data.courseName);
    const closures = (data.courseClosures ?? {}) as Record<string, unknown>;

    const closureEntries = Object.entries(closures).filter(
      ([, value]) => value && typeof value === "object",
    );

    closureEntries.forEach(([courseIdKey, closureValue]) => {
      const courseId = courseIdKey.trim();
      if (!courseId) return;
      const closure = closureValue as Record<string, unknown>;
      const status = closure.status === "closed" ? "closed" : "open";

      upsert({
        id: rowKey(groupId, courseId),
        groupId,
        groupName,
        courseId,
        courseName: resolveCourseName(courseId, fallbackCourseName),
        status,
        finalGrade: toNumberOrNull(closure.finalGrade),
        autoGrade: toNumberOrNull(closure.autoGrade),
        pendingUngradedCount: toNumberOrNull(closure.pendingUngradedCount),
        closedAt: toDateOrNull(closure.closedAt),
        updatedAt: toDateOrNull(closure.updatedAt),
        archived,
      });
    });

    // Inscripciones antiguas: una sola materia y la nota final en la raíz.
    if (closureEntries.length === 0) {
      const courseId = trimSafeString(data.courseId);
      if (!courseId) return;
      const finalGrade = toNumberOrNull(data.finalGrade);
      upsert({
        id: rowKey(groupId, courseId),
        groupId,
        groupName,
        courseId,
        courseName: resolveCourseName(courseId, fallbackCourseName),
        status: finalGrade !== null ? "closed" : "open",
        finalGrade,
        autoGrade: null,
        pendingUngradedCount: null,
        closedAt: null,
        updatedAt: toDateOrNull(data.enrolledAt),
        archived,
      });
    }
  };

  archivedDocs.forEach((docSnap) => ingest(docSnap.data(), true));
  liveDocs.forEach((docSnap) => ingest(docSnap.data(), false));

  return Array.from(rows.values()).sort((a, b) => {
    if (a.status !== b.status) return a.status === "closed" ? -1 : 1;
    return rowTimestamp(b) - rowTimestamp(a) || a.courseName.localeCompare(b.courseName, "es");
  });
};

/** Promedio de las materias cerradas con calificación numérica. */
export const kardexAverage = (rows: KardexRow[]): number | null => {
  const graded = rows.filter((row) => row.status === "closed" && row.finalGrade !== null);
  if (graded.length === 0) return null;
  return graded.reduce((sum, row) => sum + (row.finalGrade ?? 0), 0) / graded.length;
};
