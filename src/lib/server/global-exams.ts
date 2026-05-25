import * as admin from "firebase-admin";
import {
  GLOBAL_EXAM_MAX_ATTEMPTS,
  GLOBAL_EXAM_PASS_SCORE,
  type GlobalExamAssignmentReason,
  type GlobalExamAssignmentRecord,
  type GlobalExamAssignmentStatus,
  type GlobalExamAttemptRecord,
  type GlobalExamTemplateRecord,
  normalizeGlobalExamQuestions,
} from "@/lib/global-exams/types";
import { getAdminFirestore } from "@/lib/firebase/admin";
import {
  type GlobalExamAccessContext,
  isGlobalExamAdminRole,
  isGlobalExamCoordinatorRole,
  isGlobalExamStudentRole,
} from "@/lib/server/global-exams-access";
import { isStudentStatusActive } from "@/lib/students/status";

type FirestoreRecord = Record<string, unknown>;

export type GlobalExamCandidateEnrollment = {
  enrollmentId: string;
  groupId: string;
  groupName: string;
  courseId: string;
  courseName: string;
  plantelId: string;
  plantelName: string;
};

type SyncGlobalExamGradeParams = {
  assignmentId: string;
  studentId: string;
  studentName: string;
  studentEmail: string;
  groupId: string;
  groupName: string;
  courseId: string;
  courseName: string;
  plantelId: string;
  plantelName: string;
  score: number;
  attemptNumber: number;
  attemptId: string;
  passed: boolean;
};

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asObject(value: unknown): FirestoreRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as FirestoreRecord)
    : {};
}

function toIsoString(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value === "object" && value !== null) {
    if ("toDate" in value && typeof (value as { toDate?: unknown }).toDate === "function") {
      try {
        return (value as { toDate: () => Date }).toDate().toISOString();
      } catch {
        return null;
      }
    }
    if ("toMillis" in value && typeof (value as { toMillis?: unknown }).toMillis === "function") {
      try {
        return new Date((value as { toMillis: () => number }).toMillis()).toISOString();
      } catch {
        return null;
      }
    }
    const seconds = (value as { seconds?: unknown }).seconds;
    const nanoseconds = (value as { nanoseconds?: unknown }).nanoseconds;
    if (typeof seconds === "number" && Number.isFinite(seconds)) {
      const nanos = typeof nanoseconds === "number" && Number.isFinite(nanoseconds) ? nanoseconds : 0;
      return new Date(Math.trunc(seconds * 1000 + nanos / 1_000_000)).toISOString();
    }
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return null;
}

function getGroupCourseIds(groupData: FirestoreRecord): string[] {
  const courseIds = Array.isArray(groupData.courseIds)
    ? groupData.courseIds.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      )
    : [];
  if (courseIds.length > 0) {
    return Array.from(new Set(courseIds.map((courseId) => courseId.trim()).filter(Boolean)));
  }
  const legacyCourseId = asTrimmedString(groupData.courseId);
  return legacyCourseId ? [legacyCourseId] : [];
}

export function toGlobalExamTemplateRecord(
  id: string,
  rawData: FirestoreRecord,
): GlobalExamTemplateRecord {
  const questions = normalizeGlobalExamQuestions(rawData.questions ?? []);
  return {
    id,
    title: asTrimmedString(rawData.title) || "Examen global",
    description: asTrimmedString(rawData.description),
    status: rawData.status === "published" ? "published" : "draft",
    courseId: asTrimmedString(rawData.courseId),
    courseName: asTrimmedString(rawData.courseName),
    passScore: asNumberOrNull(rawData.passScore) ?? GLOBAL_EXAM_PASS_SCORE,
    maxAttempts: asNumberOrNull(rawData.maxAttempts) ?? GLOBAL_EXAM_MAX_ATTEMPTS,
    questionCount: questions.length,
    questions,
    createdById: asTrimmedString(rawData.createdById),
    createdByName: asTrimmedString(rawData.createdByName),
    updatedById: asTrimmedString(rawData.updatedById),
    updatedByName: asTrimmedString(rawData.updatedByName),
    createdAt: toIsoString(rawData.createdAt),
    updatedAt: toIsoString(rawData.updatedAt),
  };
}

export function toGlobalExamAssignmentRecord(
  id: string,
  rawData: FirestoreRecord,
): GlobalExamAssignmentRecord {
  const attemptsAllowed = asNumberOrNull(rawData.attemptsAllowed) ?? GLOBAL_EXAM_MAX_ATTEMPTS;
  const attemptsUsed = asNumberOrNull(rawData.attemptsUsed) ?? 0;
  const rawStatus = asTrimmedString(rawData.status);
  const status: GlobalExamAssignmentStatus =
    rawStatus === "enabled" ||
    rawStatus === "passed" ||
    rawStatus === "failed" ||
    rawStatus === "disabled"
      ? rawStatus
      : "draft";
  const rawReason = asTrimmedString(rawData.reason);
  const reason: GlobalExamAssignmentReason =
    rawReason === "late_joiner" ? "late_joiner" : "failed_course";

  return {
    id,
    templateId: asTrimmedString(rawData.templateId),
    templateTitle: asTrimmedString(rawData.templateTitle),
    courseId: asTrimmedString(rawData.courseId),
    courseName: asTrimmedString(rawData.courseName),
    groupId: asTrimmedString(rawData.groupId),
    groupName: asTrimmedString(rawData.groupName),
    plantelId: asTrimmedString(rawData.plantelId),
    plantelName: asTrimmedString(rawData.plantelName),
    studentId: asTrimmedString(rawData.studentId),
    studentName: asTrimmedString(rawData.studentName),
    studentEmail: asTrimmedString(rawData.studentEmail),
    reason,
    enabled: asBoolean(rawData.enabled, false),
    status,
    attemptsAllowed,
    attemptsUsed,
    passScore: asNumberOrNull(rawData.passScore) ?? GLOBAL_EXAM_PASS_SCORE,
    latestScore: asNumberOrNull(rawData.latestScore),
    bestScore: asNumberOrNull(rawData.bestScore),
    latestAttemptNumber: asNumberOrNull(rawData.latestAttemptNumber) ?? 0,
    latestAttemptId: asTrimmedString(rawData.latestAttemptId) || null,
    passed: asBoolean(rawData.passed, false),
    paymentVerifiedAt: toIsoString(rawData.paymentVerifiedAt),
    enabledAt: toIsoString(rawData.enabledAt),
    enabledById: asTrimmedString(rawData.enabledById) || null,
    enabledByName: asTrimmedString(rawData.enabledByName) || null,
    createdById: asTrimmedString(rawData.createdById),
    createdByName: asTrimmedString(rawData.createdByName),
    updatedById: asTrimmedString(rawData.updatedById),
    updatedByName: asTrimmedString(rawData.updatedByName),
    createdAt: toIsoString(rawData.createdAt),
    updatedAt: toIsoString(rawData.updatedAt),
  };
}

export function toGlobalExamAttemptRecord(
  id: string,
  assignmentId: string,
  rawData: FirestoreRecord,
): GlobalExamAttemptRecord {
  const answers = asObject(rawData.answers);
  return {
    id,
    assignmentId,
    attemptNumber: asNumberOrNull(rawData.attemptNumber) ?? 0,
    score: asNumberOrNull(rawData.score) ?? 0,
    passed: asBoolean(rawData.passed, false),
    correctAnswers: asNumberOrNull(rawData.correctAnswers) ?? 0,
    totalQuestions: asNumberOrNull(rawData.totalQuestions) ?? 0,
    answers: Object.entries(answers).reduce<Record<string, string>>((acc, [questionId, answer]) => {
      const normalizedQuestionId = asTrimmedString(questionId);
      const normalizedAnswer = asTrimmedString(answer);
      if (!normalizedQuestionId || !normalizedAnswer) return acc;
      acc[normalizedQuestionId] = normalizedAnswer;
      return acc;
    }, {}),
    submittedAt: toIsoString(rawData.submittedAt),
  };
}

export async function getGlobalExamTemplates(): Promise<GlobalExamTemplateRecord[]> {
  const snap = await getAdminFirestore()
    .collection("globalExamTemplates")
    .orderBy("updatedAt", "desc")
    .get();

  return snap.docs.map((docSnap) => toGlobalExamTemplateRecord(docSnap.id, docSnap.data() as FirestoreRecord));
}

export async function getGlobalExamAssignments(): Promise<GlobalExamAssignmentRecord[]> {
  const snap = await getAdminFirestore()
    .collection("globalExamAssignments")
    .orderBy("updatedAt", "desc")
    .get();

  return snap.docs.map((docSnap) =>
    toGlobalExamAssignmentRecord(docSnap.id, docSnap.data() as FirestoreRecord),
  );
}

export function canAccessGlobalExamAssignment(
  context: GlobalExamAccessContext,
  assignment: Pick<GlobalExamAssignmentRecord, "studentId" | "groupId" | "plantelId">,
  coordinatorScopeGroupIds: Set<string>,
): boolean {
  if (isGlobalExamAdminRole(context.role)) return true;
  if (isGlobalExamStudentRole(context.role)) {
    return context.uid === assignment.studentId;
  }
  if (!isGlobalExamCoordinatorRole(context.role)) return false;
  if (assignment.plantelId && context.plantelIds.includes(assignment.plantelId)) return true;
  return coordinatorScopeGroupIds.has(assignment.groupId);
}

export async function resolveStudentCourseEnrollments(
  studentId: string,
  courseId: string,
  allowedGroupIds?: Set<string>,
): Promise<GlobalExamCandidateEnrollment[]> {
  const normalizedStudentId = studentId.trim();
  const normalizedCourseId = courseId.trim();
  if (!normalizedStudentId || !normalizedCourseId) return [];

  const db = getAdminFirestore();
  const enrollmentSnap = await db
    .collection("studentEnrollments")
    .where("studentId", "==", normalizedStudentId)
    .get();

  const enrollmentDocs = enrollmentSnap.docs.filter((docSnap) => {
    const data = docSnap.data() as FirestoreRecord;
    return isStudentStatusActive(data.status);
  });

  const groupIds = Array.from(
    new Set(
      enrollmentDocs
        .map((docSnap) => asTrimmedString((docSnap.data() as FirestoreRecord).groupId))
        .filter(Boolean),
    ),
  );

  const groupDocs = await Promise.all(groupIds.map((groupId) => db.collection("groups").doc(groupId).get()));
  const groupsById = new Map<string, FirestoreRecord>();
  groupDocs.forEach((groupSnap) => {
    if (!groupSnap.exists) return;
    groupsById.set(groupSnap.id, groupSnap.data() as FirestoreRecord);
  });

  const candidates = enrollmentDocs
    .map((docSnap) => {
      const enrollmentData = docSnap.data() as FirestoreRecord;
      const groupId = asTrimmedString(enrollmentData.groupId);
      if (!groupId) return null;
      if (allowedGroupIds && !allowedGroupIds.has(groupId)) return null;

      const groupData = groupsById.get(groupId);
      if (!groupData) return null;

      const courseIds = getGroupCourseIds(groupData);
      if (!courseIds.includes(normalizedCourseId)) return null;

      return {
        enrollmentId: docSnap.id,
        groupId,
        groupName:
          asTrimmedString(groupData.groupName) || asTrimmedString(enrollmentData.groupName) || "Grupo",
        courseId: normalizedCourseId,
        courseName:
          asTrimmedString(groupData.courseName) ||
          asTrimmedString(enrollmentData.courseName) ||
          "Materia",
        plantelId: asTrimmedString(enrollmentData.plantelId) || asTrimmedString(groupData.plantelId),
        plantelName:
          asTrimmedString(enrollmentData.plantelName) || asTrimmedString(groupData.plantelName),
      } satisfies GlobalExamCandidateEnrollment;
    })
    .filter((candidate): candidate is GlobalExamCandidateEnrollment => candidate !== null);

  const uniqueByGroup = new Map<string, GlobalExamCandidateEnrollment>();
  candidates.forEach((candidate) => {
    if (!uniqueByGroup.has(candidate.groupId)) {
      uniqueByGroup.set(candidate.groupId, candidate);
    }
  });
  return Array.from(uniqueByGroup.values());
}

export async function syncGlobalExamGradeToEnrollments(
  params: SyncGlobalExamGradeParams,
): Promise<number> {
  const db = getAdminFirestore();
  const now = admin.firestore.Timestamp.now();
  const canonicalId = `${params.groupId}_${params.studentId}`;
  const canonicalRef = db.collection("studentEnrollments").doc(canonicalId);

  const [canonicalSnap, enrollmentSnap] = await Promise.all([
    canonicalRef.get(),
    db.collection("studentEnrollments").where("studentId", "==", params.studentId).get(),
  ]);

  const targetDocs: admin.firestore.DocumentSnapshot[] = enrollmentSnap.docs.filter((docSnap) => {
    const data = docSnap.data() as FirestoreRecord;
    return asTrimmedString(data.groupId) === params.groupId;
  });

  if (canonicalSnap.exists && !targetDocs.some((docSnap) => docSnap.id === canonicalSnap.id)) {
    targetDocs.push(canonicalSnap);
  }

  if (targetDocs.length === 0) {
    const closurePayload = {
      status: "closed",
      finalGrade: params.score,
      closedAt: now,
      updatedAt: now,
      gradeSource: "globalRegularizationExam",
      globalExamScore: params.score,
      globalExamPassed: params.passed,
      globalExamAttemptNumber: params.attemptNumber,
      globalExamAssignmentId: params.assignmentId,
      globalExamAttemptId: params.attemptId,
    };
    await canonicalRef.set(
      {
        studentId: params.studentId,
        studentName: params.studentName,
        studentEmail: params.studentEmail,
        groupId: params.groupId,
        groupName: params.groupName,
        courseId: params.courseId,
        courseName: params.courseName,
        plantelId: params.plantelId,
        plantelName: params.plantelName,
        status: "active",
        finalGrade: params.score,
        updatedAt: now,
        courseClosures: {
          [params.courseId]: closurePayload,
        },
      },
      { merge: true },
    );
    return 1;
  }

  await Promise.all(
    targetDocs.map(async (docSnap) => {
      const data = docSnap.data() as FirestoreRecord;
      const courseClosures = asObject(data.courseClosures);
      const previousClosure = asObject(courseClosures[params.courseId]);
      const closurePayload = {
        ...previousClosure,
        status: "closed",
        finalGrade: params.score,
        closedAt: now,
        updatedAt: now,
        gradeSource: "globalRegularizationExam",
        globalExamScore: params.score,
        globalExamPassed: params.passed,
        globalExamAttemptNumber: params.attemptNumber,
        globalExamAssignmentId: params.assignmentId,
        globalExamAttemptId: params.attemptId,
      };

      const updatePayload: Record<string, unknown> = {
        studentId: params.studentId,
        studentName: params.studentName,
        studentEmail: params.studentEmail,
        groupId: params.groupId,
        groupName: params.groupName || asTrimmedString(data.groupName),
        courseName: params.courseName || asTrimmedString(data.courseName),
        plantelId: params.plantelId || asTrimmedString(data.plantelId),
        plantelName: params.plantelName || asTrimmedString(data.plantelName),
        updatedAt: now,
        courseClosures: {
          [params.courseId]: closurePayload,
        },
      };

      const primaryCourseId = asTrimmedString(data.courseId);
      if (!primaryCourseId || primaryCourseId === params.courseId) {
        updatePayload.courseId = params.courseId;
        updatePayload.finalGrade = params.score;
      }

      await docSnap.ref.set(updatePayload, { merge: true });
    }),
  );

  return targetDocs.length;
}
