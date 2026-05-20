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

export type TeacherEvaluation = {
  id: string;
  classDocId: string;
  courseId: string;
  lessonId: string;
  groupId: string;
  groupName: string;
  enrollmentId: string;
  teacherId: string;
  teacherName: string;
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

export type UpsertTeacherEvaluationInput = {
  classDocId: string;
  courseId: string;
  lessonId: string;
  groupId: string;
  groupName?: string;
  enrollmentId: string;
  teacherId: string;
  teacherName: string;
  studentId: string;
  studentName: string;
  rating: number;
  comment?: string;
  courseTitle?: string;
  lessonTitle?: string;
  classTitle?: string;
};

export type TeacherEvaluationsQuery = {
  courseId?: string;
  teacherQuery?: string;
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

const normalizeForSearch = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

export const buildTeacherEvaluationId = (
  classDocId: string,
  groupId: string,
  teacherId: string,
  studentId: string,
): string =>
  [
    groupId.trim(),
    teacherId.trim(),
    classDocId.trim(),
    studentId.trim(),
  ].join("_");

const mapTeacherEvaluation = (id: string, data: Record<string, unknown>): TeacherEvaluation => ({
  id,
  classDocId: normalizeText(data.classDocId),
  courseId: normalizeText(data.courseId),
  lessonId: normalizeText(data.lessonId),
  groupId: normalizeText(data.groupId),
  groupName: normalizeText(data.groupName),
  enrollmentId: normalizeText(data.enrollmentId),
  teacherId: normalizeText(data.teacherId),
  teacherName: normalizeText(data.teacherName, "Profesor"),
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

export async function upsertTeacherEvaluation(
  input: UpsertTeacherEvaluationInput,
): Promise<string> {
  const classDocId = input.classDocId.trim();
  const groupId = input.groupId.trim();
  const teacherId = input.teacherId.trim();
  const studentId = input.studentId.trim();

  if (!classDocId) {
    throw new Error("classDocId es requerido");
  }
  if (!groupId) {
    throw new Error("groupId es requerido");
  }
  if (!teacherId) {
    throw new Error("teacherId es requerido");
  }
  if (!studentId) {
    throw new Error("studentId es requerido");
  }

  const roundedRating =
    typeof input.rating === "number" ? Math.round(input.rating) : Number.NaN;
  if (
    roundedRating !== 1 &&
    roundedRating !== 2 &&
    roundedRating !== 3 &&
    roundedRating !== 4 &&
    roundedRating !== 5
  ) {
    throw new Error("rating debe estar entre 1 y 5");
  }

  const rating = roundedRating;
  const id = buildTeacherEvaluationId(classDocId, groupId, teacherId, studentId);
  const ref = doc(db, "teacherEvaluations", id);
  const now = new Date();

  await setDoc(
    ref,
    {
      classDocId,
      courseId: input.courseId.trim(),
      lessonId: input.lessonId.trim(),
      groupId,
      groupName: (input.groupName ?? "").trim(),
      enrollmentId: input.enrollmentId.trim(),
      teacherId,
      teacherName: input.teacherName.trim() || "Profesor",
      studentId,
      studentName: input.studentName.trim() || "Estudiante",
      rating,
      comment: (input.comment ?? "").trim(),
      courseTitle: (input.courseTitle ?? "").trim(),
      lessonTitle: (input.lessonTitle ?? "").trim(),
      classTitle: (input.classTitle ?? "").trim(),
      createdAt: now,
      updatedAt: now,
    },
    { merge: true },
  );

  return id;
}

export async function getTeacherEvaluationsForStudent(
  studentId: string,
): Promise<Record<string, TeacherEvaluation>> {
  const normalizedStudentId = studentId.trim();
  if (!normalizedStudentId) return {};

  const snap = await getDocs(
    query(
      collection(db, "teacherEvaluations"),
      where("studentId", "==", normalizedStudentId),
      limit(DEFAULT_MAX_RESULTS),
    ),
  );

  const sorted = snap.docs
    .map((docSnap) => mapTeacherEvaluation(docSnap.id, docSnap.data()))
    .sort((a, b) => getSortTime(b.updatedAt) - getSortTime(a.updatedAt));

  return sorted.reduce<Record<string, TeacherEvaluation>>((acc, evaluation) => {
    if (!evaluation.id || acc[evaluation.id]) {
      return acc;
    }
    acc[evaluation.id] = evaluation;
    return acc;
  }, {});
}

export async function listTeacherEvaluations(
  options: TeacherEvaluationsQuery = {},
): Promise<TeacherEvaluation[]> {
  const snap = await getDocs(
    query(
      collection(db, "teacherEvaluations"),
      orderBy("updatedAt", "desc"),
      limit(options.maxResults ?? DEFAULT_MAX_RESULTS),
    ),
  );

  const normalizedCourseId = options.courseId?.trim() ?? "";
  const normalizedTeacherQuery = normalizeForSearch(options.teacherQuery?.trim() ?? "");
  const startDateTime = options.startDate?.getTime() ?? null;
  const endDateTime = options.endDate?.getTime() ?? null;

  return snap.docs
    .map((docSnap) => mapTeacherEvaluation(docSnap.id, docSnap.data()))
    .filter((entry) => {
      if (normalizedCourseId && entry.courseId !== normalizedCourseId) {
        return false;
      }
      if (normalizedTeacherQuery) {
        const teacherSearchPool = normalizeForSearch(
          [entry.teacherName, entry.teacherId].filter(Boolean).join(" "),
        );
        if (!teacherSearchPool.includes(normalizedTeacherQuery)) {
          return false;
        }
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
