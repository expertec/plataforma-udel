import {
  collection,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  setDoc,
  Timestamp,
  where,
} from "firebase/firestore";
import { db } from "./firestore";

export type ClassEvaluation = {
  id: string;
  classDocId: string;
  courseId: string;
  lessonId: string;
  groupId: string;
  enrollmentId: string;
  studentId: string;
  studentName: string;
  rating: 1 | 2 | 3 | 4 | 5;
  comment: string;
  createdAt: Date | null;
  updatedAt: Date | null;
  courseTitle?: string;
  lessonTitle?: string;
  classTitle?: string;
};

export type UpsertClassEvaluationInput = {
  classDocId: string;
  courseId: string;
  lessonId: string;
  groupId: string;
  enrollmentId: string;
  studentId: string;
  studentName: string;
  rating: number;
  comment?: string;
  courseTitle?: string;
  lessonTitle?: string;
  classTitle?: string;
};

export type ClassEvaluationsQuery = {
  courseId?: string;
  startDate?: Date;
  endDate?: Date;
  maxResults?: number;
};

const DEFAULT_MAX_RESULTS = 1000;

const toDate = (value: unknown): Date | null => {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (value instanceof Timestamp) {
    const parsed = value.toDate();
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (typeof value === "object" && value !== null && "toDate" in value && typeof (value as { toDate?: unknown }).toDate === "function") {
    try {
      const parsed = (value as { toDate: () => Date }).toDate();
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    } catch {
      return null;
    }
  }
  return null;
};

const normalizeText = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value.trim() : fallback;

const normalizeRating = (value: unknown): 1 | 2 | 3 | 4 | 5 => {
  const parsed = typeof value === "number" ? Math.round(value) : Number.NaN;
  if (parsed === 1 || parsed === 2 || parsed === 3 || parsed === 4 || parsed === 5) {
    return parsed;
  }
  return 5;
};

const getSortTime = (value: Date | null): number => (value ? value.getTime() : 0);

export const buildClassEvaluationId = (classDocId: string, studentId: string): string =>
  `${classDocId.trim()}_${studentId.trim()}`;

const mapClassEvaluation = (id: string, data: Record<string, unknown>): ClassEvaluation => ({
  id,
  classDocId: normalizeText(data.classDocId),
  courseId: normalizeText(data.courseId),
  lessonId: normalizeText(data.lessonId),
  groupId: normalizeText(data.groupId),
  enrollmentId: normalizeText(data.enrollmentId),
  studentId: normalizeText(data.studentId),
  studentName: normalizeText(data.studentName, "Estudiante"),
  rating: normalizeRating(data.rating),
  comment: normalizeText(data.comment),
  createdAt: toDate(data.createdAt),
  updatedAt: toDate(data.updatedAt),
  courseTitle: normalizeText(data.courseTitle),
  lessonTitle: normalizeText(data.lessonTitle),
  classTitle: normalizeText(data.classTitle),
});

export async function upsertClassEvaluation(input: UpsertClassEvaluationInput): Promise<string> {
  const classDocId = input.classDocId.trim();
  const studentId = input.studentId.trim();
  if (!classDocId) {
    throw new Error("classDocId es requerido");
  }
  if (!studentId) {
    throw new Error("studentId es requerido");
  }
  const roundedRating =
    typeof input.rating === "number" ? Math.round(input.rating) : Number.NaN;
  if (roundedRating !== 1 && roundedRating !== 2 && roundedRating !== 3 && roundedRating !== 4 && roundedRating !== 5) {
    throw new Error("rating debe estar entre 1 y 5");
  }
  const rating = roundedRating;
  const id = buildClassEvaluationId(classDocId, studentId);
  const ref = doc(db, "classEvaluations", id);
  const now = new Date();
  const payload = {
    classDocId,
    courseId: input.courseId.trim(),
    lessonId: input.lessonId.trim(),
    groupId: input.groupId.trim(),
    enrollmentId: input.enrollmentId.trim(),
    studentId,
    studentName: input.studentName.trim() || "Estudiante",
    rating,
    comment: (input.comment ?? "").trim(),
    courseTitle: (input.courseTitle ?? "").trim(),
    lessonTitle: (input.lessonTitle ?? "").trim(),
    classTitle: (input.classTitle ?? "").trim(),
  };

  // setDoc con merge funciona como create/update sin requerir un read previo.
  await setDoc(
    ref,
    {
      ...payload,
      createdAt: now,
      updatedAt: now,
    },
    { merge: true },
  );

  return id;
}

export async function getClassEvaluationsForStudent(studentId: string): Promise<Record<string, ClassEvaluation>> {
  const normalizedStudentId = studentId.trim();
  if (!normalizedStudentId) return {};

  const snap = await getDocs(
    query(
      collection(db, "classEvaluations"),
      where("studentId", "==", normalizedStudentId),
      limit(DEFAULT_MAX_RESULTS),
    ),
  );

  const sorted = snap.docs
    .map((docSnap) => mapClassEvaluation(docSnap.id, docSnap.data()))
    .sort((a, b) => getSortTime(b.updatedAt) - getSortTime(a.updatedAt));

  return sorted.reduce<Record<string, ClassEvaluation>>((acc, evaluation) => {
    if (!evaluation.classDocId || acc[evaluation.classDocId]) {
      return acc;
    }
    acc[evaluation.classDocId] = evaluation;
    return acc;
  }, {});
}

export async function listClassEvaluations(
  options: ClassEvaluationsQuery = {},
): Promise<ClassEvaluation[]> {
  const snap = await getDocs(
    query(
      collection(db, "classEvaluations"),
      orderBy("updatedAt", "desc"),
      limit(options.maxResults ?? DEFAULT_MAX_RESULTS),
    ),
  );

  const normalizedCourseId = options.courseId?.trim() ?? "";
  const startDateTime = options.startDate?.getTime() ?? null;
  const endDateTime = options.endDate?.getTime() ?? null;

  return snap.docs
    .map((docSnap) => mapClassEvaluation(docSnap.id, docSnap.data()))
    .filter((entry) => {
      if (normalizedCourseId && entry.courseId !== normalizedCourseId) {
        return false;
      }
      const updatedAtTime = entry.updatedAt?.getTime() ?? 0;
      if (startDateTime !== null && updatedAtTime < startDateTime) {
        return false;
      }
      if (endDateTime !== null && updatedAtTime > endDateTime) {
        return false;
      }
      return true;
    })
    .sort((a, b) => getSortTime(b.updatedAt) - getSortTime(a.updatedAt));
}
