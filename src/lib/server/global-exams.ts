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

type EnsureGlobalExamStudyEnrollmentParams = {
  studentId: string;
  studentName: string;
  studentEmail: string;
  courseId: string;
  courseName: string;
  plantelId?: string;
  plantelName?: string;
  groupId?: string;
  groupName?: string;
  assignmentId?: string;
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

function getGlobalExamStudyEnrollmentId(courseId: string, studentId: string): string {
  return `globalExamStudy_${courseId.trim()}_${studentId.trim()}`;
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

function normalizeComparableText(value: unknown): string {
  return asTrimmedString(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function getGroupCourses(
  groupData: FirestoreRecord,
): Array<{ courseId: string; courseName: string }> {
  const directCourses = Array.isArray(groupData.courses)
    ? groupData.courses
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const record = item as FirestoreRecord;
          const courseId = asTrimmedString(record.courseId);
          if (!courseId) return null;
          return {
            courseId,
            courseName: asTrimmedString(record.courseName),
          };
        })
        .filter((item): item is { courseId: string; courseName: string } => item !== null)
    : [];
  if (directCourses.length > 0) return directCourses;

  const legacyCourseId = asTrimmedString(groupData.courseId);
  if (!legacyCourseId) return [];
  return [
    {
      courseId: legacyCourseId,
      courseName: asTrimmedString(groupData.courseName),
    },
  ];
}

function hasCourseClosure(
  enrollmentData: FirestoreRecord,
  courseId: string,
): boolean {
  if (!courseId) return false;
  const closures = asObject(enrollmentData.courseClosures);
  const directMatch = closures[courseId];
  if (directMatch && typeof directMatch === "object") return true;
  return Object.keys(closures).some((key) => asTrimmedString(key) === courseId);
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
  courseId?: string,
  allowedGroupIds?: Set<string>,
  courseName?: string,
): Promise<GlobalExamCandidateEnrollment[]> {
  const normalizedStudentId = studentId.trim();
  const normalizedCourseId = asTrimmedString(courseId);
  const normalizedCourseName = normalizeComparableText(courseName);
  const filterByCourse = normalizedCourseId.length > 0;
  if (!normalizedStudentId) return [];

  const db = getAdminFirestore();
  const enrollmentSnap = await db
    .collection("studentEnrollments")
    .where("studentId", "==", normalizedStudentId)
    .get();

  const activeEnrollmentDocs = enrollmentSnap.docs.filter((docSnap) => {
    const data = docSnap.data() as FirestoreRecord;
    return isStudentStatusActive(data.status);
  });

  const groupIds = Array.from(
    new Set(
      enrollmentSnap.docs
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

  const buildCandidate = (
    docSnap: admin.firestore.QueryDocumentSnapshot,
    options?: {
      allowMissingGroupCourseMatch?: boolean;
      allowMissingGroupDoc?: boolean;
    },
  ): GlobalExamCandidateEnrollment | null => {
    const enrollmentData = docSnap.data() as FirestoreRecord;
    const groupId = asTrimmedString(enrollmentData.groupId);
    if (!groupId) return null;
    if (allowedGroupIds && !allowedGroupIds.has(groupId)) return null;

    const groupData = groupsById.get(groupId);
    if (!groupData && !options?.allowMissingGroupDoc) return null;

    const groupCourses = groupData ? getGroupCourses(groupData) : [];
    const courseIds = groupCourses.map((course) => course.courseId);
    const matchedGroupCourseByName =
      normalizedCourseName.length > 0
        ? groupCourses.find((course) => normalizeComparableText(course.courseName) === normalizedCourseName)
        : undefined;
    const enrollmentCourseId = asTrimmedString(enrollmentData.courseId);
    const enrollmentCourseName = asTrimmedString(enrollmentData.courseName);
    const historicalCourseMatch =
      filterByCourse &&
      (
        enrollmentCourseId === normalizedCourseId ||
        hasCourseClosure(enrollmentData, normalizedCourseId) ||
        (normalizedCourseName.length > 0 &&
          (normalizeComparableText(enrollmentCourseName) === normalizedCourseName ||
            Boolean(matchedGroupCourseByName)))
      );

    if (
      filterByCourse &&
      !courseIds.includes(normalizedCourseId) &&
      !historicalCourseMatch &&
      !options?.allowMissingGroupCourseMatch
    ) {
      return null;
    }

    const matchedCourseId =
      normalizedCourseId ||
      enrollmentCourseId ||
      matchedGroupCourseByName?.courseId ||
      courseIds[0] ||
      "";
    const matchedCourseName =
      matchedGroupCourseByName?.courseName ||
      enrollmentCourseName ||
      asTrimmedString(groupData?.courseName) ||
      "Materia";

    const resolvedCourseId = filterByCourse
      ? matchedCourseId
      : enrollmentCourseId || courseIds[0] || "";
    const resolvedCourseName = filterByCourse
      ? matchedCourseName
      : asTrimmedString(enrollmentData.courseName) ||
        asTrimmedString(groupData?.courseName) ||
        "Sin materia";

    return {
      enrollmentId: docSnap.id,
      groupId,
      groupName:
        asTrimmedString(groupData?.groupName) || asTrimmedString(enrollmentData.groupName) || "Grupo",
      courseId: resolvedCourseId,
      courseName: resolvedCourseName,
      plantelId: asTrimmedString(enrollmentData.plantelId) || asTrimmedString(groupData?.plantelId),
      plantelName:
        asTrimmedString(enrollmentData.plantelName) || asTrimmedString(groupData?.plantelName),
    } satisfies GlobalExamCandidateEnrollment;
  };

  const candidates = activeEnrollmentDocs
    .map((docSnap) => {
      return buildCandidate(docSnap);
    })
    .filter((candidate): candidate is GlobalExamCandidateEnrollment => candidate !== null);

  const uniqueByGroup = new Map<string, GlobalExamCandidateEnrollment>();
  candidates.forEach((candidate) => {
    if (!uniqueByGroup.has(candidate.groupId)) {
      uniqueByGroup.set(candidate.groupId, candidate);
    }
  });
  if (uniqueByGroup.size > 0 || !filterByCourse) {
    return Array.from(uniqueByGroup.values());
  }

  // Fallback historico: si la materia ya habia estado en otra inscripcion del
  // alumno, reutilizamos ese enrollment para sincronizar el examen global al
  // kardex previo, aunque el grupo actual ya no tenga ligada la materia.
  const historicalByGroup = new Map<string, GlobalExamCandidateEnrollment>();
  enrollmentSnap.docs.forEach((docSnap) => {
    const enrollmentData = docSnap.data() as FirestoreRecord;
    const groupId = asTrimmedString(enrollmentData.groupId);
    const groupData = groupId ? groupsById.get(groupId) : undefined;
    const groupCourses = groupData ? getGroupCourses(groupData) : [];
    const courseIds = groupCourses.map((course) => course.courseId);
    const enrollmentCourseId = asTrimmedString(enrollmentData.courseId);
    const enrollmentCourseName = asTrimmedString(enrollmentData.courseName);
    const hasHistoricalMatch =
      courseIds.includes(normalizedCourseId) ||
      enrollmentCourseId === normalizedCourseId ||
      hasCourseClosure(enrollmentData, normalizedCourseId) ||
      (normalizedCourseName.length > 0 &&
        (normalizeComparableText(enrollmentCourseName) === normalizedCourseName ||
          groupCourses.some((course) => normalizeComparableText(course.courseName) === normalizedCourseName)));
    if (!hasHistoricalMatch) return;

    const candidate = buildCandidate(docSnap, {
      allowMissingGroupCourseMatch: true,
      allowMissingGroupDoc: true,
    });
    if (!candidate) return;
    if (!historicalByGroup.has(candidate.groupId)) {
      historicalByGroup.set(candidate.groupId, candidate);
    }
  });

  return Array.from(historicalByGroup.values());
}

export async function ensureGlobalExamStudyEnrollment(
  params: EnsureGlobalExamStudyEnrollmentParams,
): Promise<string | null> {
  const studentId = asTrimmedString(params.studentId);
  const courseId = asTrimmedString(params.courseId);
  if (!studentId || !courseId) return null;

  const enrollmentId = getGlobalExamStudyEnrollmentId(courseId, studentId);
  const now = admin.firestore.Timestamp.now();
  await getAdminFirestore()
    .collection("studentEnrollments")
    .doc(enrollmentId)
    .set(
      {
        studentId,
        studentName: asTrimmedString(params.studentName) || "Alumno",
        studentEmail: asTrimmedString(params.studentEmail),
        groupId: asTrimmedString(params.groupId),
        groupName: asTrimmedString(params.groupName) || "Modo estudio",
        courseId,
        courseName: asTrimmedString(params.courseName) || "Materia",
        plantelId: asTrimmedString(params.plantelId),
        plantelName: asTrimmedString(params.plantelName),
        status: "active",
        source: "globalExamStudy",
        studyOnly: true,
        globalExamAssignmentId: asTrimmedString(params.assignmentId),
        enrolledAt: now,
        updatedAt: now,
      },
      { merge: true },
    );

  return enrollmentId;
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
    if (!params.groupId) {
      return 0;
    }
    const closurePayload = {
      status: "closed",
      finalGrade: params.score,
      courseName: params.courseName,
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
        courseName: params.courseName,
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
