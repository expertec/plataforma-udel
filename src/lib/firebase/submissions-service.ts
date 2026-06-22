import {
  addDoc,
  collection,
  doc,
  getDocs,
  getDoc,
  limit,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
  updateDoc,
  where,
  deleteDoc,
} from "firebase/firestore";
import { auth } from "@/lib/firebase/client";
import { db } from "@/lib/firebase/firestore";

export type SubmissionStatus = "pending" | "graded" | "late";

export type SubmissionAnswer = {
  questionId?: string;
  question?: string;
  questionPointValue?: number;
  selectedOptionId?: string;
  selectedOptionText?: string;
  isCorrect?: boolean;
  [key: string]: unknown;
};

export type Submission = {
  id: string;
  classId: string;
  classDocId?: string;
  courseId?: string;
  courseTitle?: string;
  lessonId?: string;
  lessonTitle?: string;
  className: string;
  classType: string;
  studentId: string;
  studentName: string;
  submittedAt?: Date | null;
  fileUrl?: string;
  audioUrl?: string;
  content?: string;
  status: SubmissionStatus;
  grade?: number;
  answers?: SubmissionAnswer[];
  feedback?: string;
  gradedAt?: Date | null;
  gradedById?: string;
  gradedByName?: string;
};

type SubmissionsApiResponse = {
  success?: boolean;
  error?: string;
  data?: {
    submissions?: Array<{
      id: string;
      classId: string;
      classDocId?: string;
      courseId?: string;
      courseTitle?: string;
      lessonId?: string;
      lessonTitle?: string;
      className: string;
      classType: string;
      studentId: string;
      studentName: string;
      submittedAtMs?: number;
      fileUrl?: string;
      audioUrl?: string;
      content?: string;
      status: string;
      grade?: number;
      answers?: SubmissionAnswer[];
      feedback?: string;
      gradedAtMs?: number;
      gradedById?: string;
      gradedByName?: string;
    }>;
  };
};

export function hasNumericSubmissionGrade(
  submission: Pick<Submission, "grade">,
): submission is Pick<Submission, "grade"> & { grade: number } {
  return typeof submission.grade === "number" && Number.isFinite(submission.grade);
}

export function getSubmissionSortTimestamp(
  submission: Pick<Submission, "submittedAt" | "gradedAt">,
): number {
  return submission.submittedAt?.getTime() ?? submission.gradedAt?.getTime() ?? 0;
}

type SubmissionClassMatchTarget = {
  classId: string;
  courseId?: string;
  lessonId?: string;
  className?: string;
  classType?: string;
};

const normalizeComparableText = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const normalizeSubmissionClassType = (value: string): string => {
  const normalized = normalizeComparableText(value);
  if (["quiz", "quizz", "cuestionario"].includes(normalized)) return "quiz";
  if (["forum", "foro", "post", "discussion"].includes(normalized)) return "forum";
  if (["assignment", "tarea", "homework"].includes(normalized)) return "assignment";
  return normalized;
};

/**
 * Matches a submission to a class using the stable doc id first and, for legacy data,
 * a stricter metadata fallback (course, lesson, title, type).
 */
export function getSubmissionClassMatchScore(
  submission: Pick<Submission, "classId" | "classDocId" | "courseId" | "lessonId" | "className" | "classType">,
  target: SubmissionClassMatchTarget,
): number {
  const targetClassId = normalizeComparableText(target.classId);
  if (!targetClassId) return 0;

  const submissionClassId = normalizeComparableText(submission.classDocId ?? submission.classId);
  if (submissionClassId && submissionClassId === targetClassId) {
    return 3;
  }

  const targetCourseId = normalizeComparableText(target.courseId ?? "");
  const submissionCourseId = normalizeComparableText(submission.courseId ?? "");
  if (targetCourseId && submissionCourseId && targetCourseId !== submissionCourseId) {
    return 0;
  }

  const targetLessonId = normalizeComparableText(target.lessonId ?? "");
  const submissionLessonId = normalizeComparableText(submission.lessonId ?? "");
  if (targetLessonId && submissionLessonId && targetLessonId !== submissionLessonId) {
    return 0;
  }

  const targetClassName = normalizeComparableText(target.className ?? "");
  const submissionClassName = normalizeComparableText(submission.className ?? "");
  if (!targetClassName || !submissionClassName || targetClassName !== submissionClassName) {
    return 0;
  }

  const targetType = normalizeSubmissionClassType(target.classType ?? "");
  const submissionType = normalizeSubmissionClassType(submission.classType);
  if (targetType && submissionType && targetType !== submissionType) {
    return 0;
  }

  if (!targetCourseId && !targetLessonId) {
    return 0;
  }

  return targetCourseId && targetLessonId ? 2 : 1;
}

/**
 * Decide si la entrega `incoming` debe reemplazar a `current` para una misma
 * actividad/alumno. Se prioriza la entrega más reciente; en empate de fecha,
 * se prefiere la que tenga calificación numérica/estado evaluado.
 */
export function shouldPreferIncomingSubmission(current: Submission, incoming: Submission): boolean {
  const currentTs = getSubmissionSortTimestamp(current);
  const incomingTs = getSubmissionSortTimestamp(incoming);
  if (incomingTs !== currentTs) return incomingTs > currentTs;

  const currentHasNumericGrade = hasNumericSubmissionGrade(current);
  const incomingHasNumericGrade = hasNumericSubmissionGrade(incoming);
  if (incomingHasNumericGrade !== currentHasNumericGrade) return incomingHasNumericGrade;

  const currentMarkedGraded = current.status === "graded" || Boolean(current.gradedAt);
  const incomingMarkedGraded = incoming.status === "graded" || Boolean(incoming.gradedAt);
  if (incomingMarkedGraded !== currentMarkedGraded) return incomingMarkedGraded;

  const currentGradedAt = current.gradedAt?.getTime() ?? 0;
  const incomingGradedAt = incoming.gradedAt?.getTime() ?? 0;
  if (incomingGradedAt !== currentGradedAt) return incomingGradedAt > currentGradedAt;

  return incoming.id > current.id;
}

type CreateSubmissionInput = {
  classId: string;
  classDocId?: string;
  courseId?: string;
  courseTitle?: string;
  lessonId?: string;
  lessonTitle?: string;
  className: string;
  classType: string;
  studentId: string;
  studentName: string;
  submittedAt?: Date;
  fileUrl?: string;
  audioUrl?: string;
  content?: string;
  status?: SubmissionStatus;
  grade?: number;
  answers?: SubmissionAnswer[];
  gradedById?: string;
  gradedByName?: string;
};

export async function createSubmission(
  groupId: string,
  data: CreateSubmissionInput,
): Promise<string> {
  // Validar estado del grupo antes de permitir la entrega
  const groupRef = doc(db, "groups", groupId);
  const groupSnap = await getDoc(groupRef);
  if (!groupSnap.exists()) {
    throw new Error("El grupo no existe");
  }
  const groupData = groupSnap.data();
  if (groupData.status && groupData.status !== "active") {
    throw new Error("El período de entregas ha finalizado");
  }

  const courseId = (data.courseId ?? "").trim();
  if (courseId && data.studentId) {
    let enrollmentData: Record<string, unknown> | null = null;
    const canonicalEnrollmentRef = doc(db, "studentEnrollments", `${groupId}_${data.studentId}`);
    const canonicalEnrollmentSnap = await getDoc(canonicalEnrollmentRef);
    if (canonicalEnrollmentSnap.exists()) {
      enrollmentData = canonicalEnrollmentSnap.data() as Record<string, unknown>;
    } else {
      const enrollmentSnap = await getDocs(
        query(
          collection(db, "studentEnrollments"),
          where("groupId", "==", groupId),
          where("studentId", "==", data.studentId),
          limit(1),
        ),
      );
      if (!enrollmentSnap.empty) {
        enrollmentData = enrollmentSnap.docs[0].data() as Record<string, unknown>;
      }
    }

    if (enrollmentData) {
      const closures = (enrollmentData.courseClosures ?? {}) as Record<string, { status?: string } | undefined>;
      const closure = closures[courseId];
      if (closure?.status === "closed") {
        throw new Error("Este curso está cerrado para el alumno.");
      }
    }
  }

  const ref = collection(db, "groups", groupId, "submissions");
  const docRef = await addDoc(ref, {
    classId: data.classId,
    ...(data.classDocId ? { classDocId: data.classDocId } : {}),
    ...(data.courseId ? { courseId: data.courseId } : {}),
    ...(data.courseTitle ? { courseTitle: data.courseTitle } : {}),
    ...(data.lessonId ? { lessonId: data.lessonId } : {}),
    ...(data.lessonTitle ? { lessonTitle: data.lessonTitle } : {}),
    className: data.className,
    classType: data.classType,
    studentId: data.studentId,
    studentName: data.studentName,
    submittedAt: data.submittedAt ? Timestamp.fromDate(data.submittedAt) : serverTimestamp(),
    fileUrl: data.fileUrl ?? "",
    audioUrl: data.audioUrl ?? "",
    content: data.content ?? "",
    status: data.status ?? "pending",
    ...(typeof data.grade === "number"
      ? {
          grade: data.grade,
          gradedAt: serverTimestamp(),
          ...(data.gradedById ? { gradedById: data.gradedById } : {}),
          ...(data.gradedByName ? { gradedByName: data.gradedByName } : {}),
        }
      : {}),
    ...(data.answers ? { answers: data.answers } : {}),
  });
  return docRef.id;
}

export async function getSubmissionsByClass(
  groupId: string,
  classId: string,
): Promise<Submission[]> {
  const all = await getAllSubmissions(groupId);
  return all.filter((submission) => submission.classId === classId);
}

export async function getAllSubmissions(groupId: string): Promise<Submission[]> {
  const currentUser = auth.currentUser;
  if (currentUser) {
    const token = await currentUser.getIdToken();
    const response = await fetch(`/api/groups/${encodeURIComponent(groupId)}/submissions`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
      cache: "no-store",
    });

    const payload = (await response.json().catch(() => ({}))) as SubmissionsApiResponse;
    if (!response.ok || payload.success === false) {
      throw new Error(payload.error ?? "No se pudieron cargar las entregas");
    }

    return (payload.data?.submissions ?? []).map((item) => ({
      id: item.id,
      classId: item.classId ?? "",
      classDocId: item.classDocId,
      courseId: item.courseId,
      courseTitle: item.courseTitle,
      lessonId: item.lessonId,
      lessonTitle: item.lessonTitle,
      className: item.className ?? "",
      classType: item.classType ?? "",
      studentId: item.studentId ?? "",
      studentName: item.studentName ?? "",
      submittedAt:
        typeof item.submittedAtMs === "number" && Number.isFinite(item.submittedAtMs)
          ? new Date(item.submittedAtMs)
          : null,
      fileUrl: item.fileUrl ?? "",
      audioUrl: item.audioUrl ?? "",
      content: item.content ?? "",
      status: (["pending", "graded", "late"] as SubmissionStatus[]).includes(
        item.status as SubmissionStatus,
      )
        ? (item.status as SubmissionStatus)
        : "pending",
      grade: item.grade,
      answers: Array.isArray(item.answers) ? item.answers : undefined,
      feedback: item.feedback ?? "",
      gradedAt:
        typeof item.gradedAtMs === "number" && Number.isFinite(item.gradedAtMs)
          ? new Date(item.gradedAtMs)
          : null,
      gradedById: item.gradedById,
      gradedByName: item.gradedByName,
    }));
  }

  return getAllSubmissionsDirect(groupId);
}

export async function getAllSubmissionsDirect(groupId: string): Promise<Submission[]> {
  const ref = collection(db, "groups", groupId, "submissions");
  const q = query(ref, orderBy("submittedAt", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map((d) => toSubmission(d.id, d.data()));
}

export async function gradeSubmission(
  groupId: string,
  submissionId: string,
  grade: number,
  feedback: string,
  gradedBy?: {
    gradedById?: string;
    gradedByName?: string;
  },
): Promise<void> {
  const ref = doc(db, "groups", groupId, "submissions", submissionId);
  await updateDoc(ref, {
    grade,
    feedback,
    gradedAt: serverTimestamp(),
    status: "graded",
    ...(gradedBy?.gradedById ? { gradedById: gradedBy.gradedById } : {}),
    ...(gradedBy?.gradedByName ? { gradedByName: gradedBy.gradedByName } : {}),
  });
}

export async function getStudentSubmissions(
  groupId: string,
  studentId: string,
): Promise<Submission[]> {
  const ref = collection(db, "groups", groupId, "submissions");
  const q = query(ref, where("studentId", "==", studentId), orderBy("submittedAt", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map((d) => toSubmission(d.id, d.data()));
}

export async function deleteSubmission(
  groupId: string,
  submissionId: string,
): Promise<void> {
  const ref = doc(db, "groups", groupId, "submissions", submissionId);
  await deleteDoc(ref);
}

type SubmissionData = {
  classId?: string;
  classDocId?: string;
  courseId?: string;
  courseTitle?: string;
  lessonId?: string;
  lessonTitle?: string;
  className?: string;
  classType?: string;
  studentId?: string;
  studentName?: string;
  submittedAt?: { toDate?: () => Date };
  fileUrl?: string;
  audioUrl?: string;
  content?: string;
  status?: SubmissionStatus | string;
  grade?: unknown;
  answers?: SubmissionAnswer[];
  feedback?: string;
  gradedAt?: { toDate?: () => Date };
  gradedById?: string;
  gradedByName?: string;
};

function normalizeSubmissionGrade(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim().replace(",", "."));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function toSubmission(id: string, data: SubmissionData): Submission {
  const normalizedGrade = normalizeSubmissionGrade(data.grade);
  const status = ["pending", "graded", "late"].includes((data.status as string) ?? "")
    ? (data.status as SubmissionStatus)
    : "pending";
  return {
    id,
    classId: data.classId ?? "",
    classDocId: data.classDocId,
    courseId: data.courseId,
    courseTitle: data.courseTitle,
    lessonId: data.lessonId,
    lessonTitle: data.lessonTitle,
    className: data.className ?? "",
    classType: data.classType ?? "",
    studentId: data.studentId ?? "",
    studentName: data.studentName ?? "",
    submittedAt: data.submittedAt?.toDate?.() ?? null,
    fileUrl: data.fileUrl ?? "",
    audioUrl: data.audioUrl ?? "",
    content: data.content ?? "",
    status,
    grade: normalizedGrade,
    answers: Array.isArray(data.answers) ? (data.answers as SubmissionAnswer[]) : undefined,
    feedback: data.feedback ?? "",
    gradedAt: data.gradedAt?.toDate?.() ?? null,
    gradedById: typeof data.gradedById === "string" ? data.gradedById : undefined,
    gradedByName: typeof data.gradedByName === "string" ? data.gradedByName : undefined,
  };
}
