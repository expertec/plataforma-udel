import { NextRequest, NextResponse } from "next/server";
import type { DocumentData, DocumentReference } from "firebase-admin/firestore";
import { getAdminFirestore } from "@/lib/firebase/admin";
import {
  GLOBAL_EXAM_DURATION_MINUTES,
  calculateGlobalExamResult,
  sanitizeGlobalExamQuestionsForStudent,
  type GlobalExamAttemptCompletionReason,
} from "@/lib/global-exams/types";
import {
  canAccessGlobalExamAssignment,
  ensureGlobalExamStudyEnrollment,
  resolveStudentCourseEnrollments,
  syncGlobalExamGradeToEnrollments,
  toGlobalExamAssignmentRecord,
  toGlobalExamAttemptRecord,
  toGlobalExamTemplateRecord,
} from "@/lib/server/global-exams";
import {
  getCoordinatorScopeGroupIds,
  requireGlobalExamAccess,
  toGlobalExamRouteErrorResponse,
} from "@/lib/server/global-exams-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

class AttemptRouteError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function loadAssignmentContext(
  request: NextRequest,
  assignmentId: string,
) {
  const access = await requireGlobalExamAccess(request, [
    "student",
    "coordinadorPlantel",
    "director",
    "adminTeacher",
    "superAdminTeacher",
  ]);
  const db = getAdminFirestore();
  const assignmentRef = db.collection("globalExamAssignments").doc(assignmentId);
  const assignmentSnap = await assignmentRef.get();

  if (!assignmentSnap.exists) {
    return {
      error: NextResponse.json(
        { success: false, error: "No se encontro la asignacion solicitada" },
        { status: 404 },
      ),
    };
  }

  const assignment = toGlobalExamAssignmentRecord(assignmentRef.id, assignmentSnap.data() ?? {});
  const coordinatorScopeGroupIds =
    access.role === "coordinadorPlantel" || access.role === "director"
      ? new Set(await getCoordinatorScopeGroupIds(access.uid, access.plantelIds))
      : new Set<string>();

  if (!canAccessGlobalExamAssignment(access, assignment, coordinatorScopeGroupIds)) {
    return {
      error: NextResponse.json(
        { success: false, error: "No tienes permisos sobre esta asignacion" },
        { status: 403 },
      ),
    };
  }

  const templateSnap = await db.collection("globalExamTemplates").doc(assignment.templateId).get();
  if (!templateSnap.exists) {
    return {
      error: NextResponse.json(
        { success: false, error: "La plantilla asociada ya no existe" },
        { status: 404 },
      ),
    };
  }

  const template = toGlobalExamTemplateRecord(templateSnap.id, templateSnap.data() ?? {});
  return {
    access,
    assignmentRef,
    assignment,
    template,
  };
}

type AttemptSession = {
  startedAt: Date;
  deadlineAt: Date;
};

type FinalizedAttemptResult = {
  attempt: {
    id: string;
    attemptNumber: number;
    score: number;
    passed: boolean;
    correctAnswers: number;
    totalQuestions: number;
    durationSeconds: number | null;
  };
  assignment: ReturnType<typeof toGlobalExamAssignmentRecord>;
  attemptsRemaining: number;
  gradeSynced: boolean;
  bestScore: number | null;
  status: string;
};

const ATTEMPT_COMPLETION_REASONS = new Set<GlobalExamAttemptCompletionReason>([
  "submitted",
  "timeout",
  "visibility_change",
  "page_exit",
]);

function toDateOrNull(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getAttemptSessionFromAssignment(assignment: {
  currentAttemptStartedAt?: string | null;
  currentAttemptDeadlineAt?: string | null;
}): AttemptSession | null {
  const startedAt = toDateOrNull(assignment.currentAttemptStartedAt);
  if (!startedAt) return null;

  const deadlineAt =
    toDateOrNull(assignment.currentAttemptDeadlineAt) ??
    new Date(startedAt.getTime() + GLOBAL_EXAM_DURATION_MINUTES * 60_000);

  return {
    startedAt,
    deadlineAt,
  };
}

function calculateAttemptDurationSeconds(session: AttemptSession | null, submittedAt: Date): number | null {
  if (!session) return null;
  const completedAtMs = Math.min(submittedAt.getTime(), session.deadlineAt.getTime());
  const elapsedMs = completedAtMs - session.startedAt.getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
  return Math.round(elapsedMs / 1000);
}

async function ensureStudentAttemptSession(params: {
  assignmentId: string;
  assignmentRef: DocumentReference<DocumentData>;
}) {
  const db = getAdminFirestore();
  return db.runTransaction(async (transaction) => {
    const snap = await transaction.get(params.assignmentRef);
    if (!snap.exists) {
      throw new AttemptRouteError(404, "La asignacion ya no existe");
    }

    const assignment = toGlobalExamAssignmentRecord(params.assignmentId, snap.data() ?? {});
    if (
      !assignment.enabled ||
      assignment.status !== "enabled" ||
      assignment.attemptsUsed >= assignment.attemptsAllowed
    ) {
      return {
        assignment,
        session: null as AttemptSession | null,
        expired: false,
      };
    }

    const now = new Date();
    const currentSession = getAttemptSessionFromAssignment(assignment);
    if (currentSession) {
      return {
        assignment,
        session: currentSession,
        expired: currentSession.deadlineAt.getTime() <= now.getTime(),
      };
    }

    const startedAt = now;
    const deadlineAt = new Date(now.getTime() + GLOBAL_EXAM_DURATION_MINUTES * 60_000);
    transaction.set(
      params.assignmentRef,
      {
        currentAttemptStartedAt: startedAt,
        currentAttemptDeadlineAt: deadlineAt,
        updatedAt: now,
      },
      { merge: true },
    );

    return {
      assignment: {
        ...assignment,
        currentAttemptStartedAt: startedAt.toISOString(),
        currentAttemptDeadlineAt: deadlineAt.toISOString(),
      },
      session: {
        startedAt,
        deadlineAt,
      },
      expired: false,
    };
  });
}

async function finalizeGlobalExamAttempt(params: {
  assignmentId: string;
  assignmentRef: DocumentReference<DocumentData>;
  assignment: ReturnType<typeof toGlobalExamAssignmentRecord>;
  template: ReturnType<typeof toGlobalExamTemplateRecord>;
  access: {
    uid: string;
    displayName?: string | null;
    email?: string | null;
  };
  answers: Record<string, string>;
  completionReason: GlobalExamAttemptCompletionReason;
}) : Promise<FinalizedAttemptResult> {
  const db = getAdminFirestore();
  const now = new Date();
  const result = calculateGlobalExamResult(
    params.template.questions,
    params.answers,
    params.assignment.passScore,
  );
  const actorName = params.access.displayName || params.access.email || "Alumno";
  const attemptRef = params.assignmentRef.collection("attempts").doc();

  let committedAttemptNumber = 0;
  let committedAssignmentStatus = params.assignment.status;
  let committedBestScore: number | null = params.assignment.bestScore;
  let committedSession: AttemptSession | null = null;
  let committedDurationSeconds: number | null = null;

  await db.runTransaction(async (transaction) => {
    const freshAssignmentSnap = await transaction.get(params.assignmentRef);
    if (!freshAssignmentSnap.exists) {
      throw new AttemptRouteError(404, "La asignacion ya no existe");
    }

    const freshAssignment = toGlobalExamAssignmentRecord(
      params.assignmentId,
      freshAssignmentSnap.data() ?? {},
    );

    if (!freshAssignment.enabled || freshAssignment.status !== "enabled") {
      throw new AttemptRouteError(400, "El examen ya no esta habilitado");
    }

    if (freshAssignment.attemptsUsed >= freshAssignment.attemptsAllowed) {
      throw new AttemptRouteError(400, "Ya no tienes intentos disponibles para este examen");
    }

    committedSession =
      getAttemptSessionFromAssignment(freshAssignment) ??
      (() => {
        const startedAt = now;
        return {
          startedAt,
          deadlineAt: new Date(startedAt.getTime() + GLOBAL_EXAM_DURATION_MINUTES * 60_000),
        };
      })();

    committedAttemptNumber = freshAssignment.attemptsUsed + 1;
    committedDurationSeconds = calculateAttemptDurationSeconds(committedSession, now);
    const nextBestScore =
      typeof freshAssignment.bestScore === "number"
        ? Math.max(freshAssignment.bestScore, result.score)
        : result.score;
    const nextStatus =
      result.passed
        ? "passed"
        : committedAttemptNumber >= freshAssignment.attemptsAllowed
          ? "failed"
          : "enabled";

    committedAssignmentStatus = nextStatus;
    committedBestScore = nextBestScore;

    transaction.set(attemptRef, {
      assignmentId: freshAssignment.id,
      attemptNumber: committedAttemptNumber,
      score: result.score,
      passed: result.passed,
      correctAnswers: result.correctAnswers,
      totalQuestions: result.totalQuestions,
      answers: result.answers,
      durationSeconds: committedDurationSeconds,
      completionReason: params.completionReason,
      startedAt: committedSession.startedAt,
      deadlineAt: committedSession.deadlineAt,
      submittedAt: now,
    });

    transaction.set(
      params.assignmentRef,
      {
        attemptsUsed: committedAttemptNumber,
        latestScore: result.score,
        bestScore: nextBestScore,
        latestAttemptNumber: committedAttemptNumber,
        latestAttemptId: attemptRef.id,
        latestAttemptDurationSeconds: committedDurationSeconds,
        passed: result.passed,
        enabled: nextStatus === "enabled",
        status: nextStatus,
        currentAttemptStartedAt: null,
        currentAttemptDeadlineAt: null,
        updatedById: params.access.uid,
        updatedByName: actorName,
        updatedAt: now,
      },
      { merge: true },
    );
  });

  let syncTarget = {
    groupId: params.assignment.groupId,
    groupName: params.assignment.groupName,
    plantelId: params.assignment.plantelId,
    plantelName: params.assignment.plantelName,
  };

  if (params.assignment.courseId && !params.assignment.groupId) {
    try {
      const historicalEnrollments = await resolveStudentCourseEnrollments(
        params.assignment.studentId,
        params.assignment.courseId,
        undefined,
        params.assignment.courseName,
      );
      const resolvedEnrollment = historicalEnrollments[0] ?? null;
      if (resolvedEnrollment) {
        syncTarget = {
          groupId: resolvedEnrollment.groupId,
          groupName: resolvedEnrollment.groupName,
          plantelId: resolvedEnrollment.plantelId || params.assignment.plantelId,
          plantelName: resolvedEnrollment.plantelName || params.assignment.plantelName,
        };
        await params.assignmentRef.set(
          {
            groupId: syncTarget.groupId,
            groupName: syncTarget.groupName,
            plantelId: syncTarget.plantelId,
            plantelName: syncTarget.plantelName,
            updatedAt: now,
          },
          { merge: true },
        );
      }
    } catch (resolveError) {
      console.error("No se pudo resolver una inscripcion historica para sincronizar kardex", resolveError);
    }
  }

  if (params.assignment.courseId) {
    try {
      await ensureGlobalExamStudyEnrollment({
        studentId: params.assignment.studentId,
        studentName: params.assignment.studentName,
        studentEmail: params.assignment.studentEmail,
        courseId: params.assignment.courseId,
        courseName: params.assignment.courseName,
        groupId: syncTarget.groupId,
        groupName: syncTarget.groupName || "Modo estudio",
        plantelId: syncTarget.plantelId,
        plantelName: syncTarget.plantelName,
        assignmentId: params.assignment.id,
      });
    } catch (studyEnrollmentError) {
      console.error("No se pudo asegurar el acceso tecnico de modo estudio", studyEnrollmentError);
    }
  }

  let gradeSynced = !params.assignment.courseId;
  if (params.assignment.courseId) {
    try {
      await syncGlobalExamGradeToEnrollments({
        assignmentId: params.assignment.id,
        studentId: params.assignment.studentId,
        studentName: params.assignment.studentName,
        studentEmail: params.assignment.studentEmail,
        groupId: syncTarget.groupId,
        groupName: syncTarget.groupName,
        courseId: params.assignment.courseId,
        courseName: params.assignment.courseName,
        plantelId: syncTarget.plantelId,
        plantelName: syncTarget.plantelName,
        score: result.score,
        attemptNumber: committedAttemptNumber,
        attemptId: attemptRef.id,
        passed: result.passed,
      });
      gradeSynced = true;
    } catch (syncError) {
      console.error("No se pudo sincronizar el resultado del examen global a kardex", syncError);
    }
  }

  const nextAssignmentSnap = await params.assignmentRef.get();
  const nextAssignment = toGlobalExamAssignmentRecord(
    params.assignmentId,
    nextAssignmentSnap.data() ?? {},
  );

  return {
    attempt: {
      id: attemptRef.id,
      attemptNumber: committedAttemptNumber,
      score: result.score,
      passed: result.passed,
      correctAnswers: result.correctAnswers,
      totalQuestions: result.totalQuestions,
      durationSeconds: committedDurationSeconds,
    },
    assignment: nextAssignment,
    attemptsRemaining: Math.max(nextAssignment.attemptsAllowed - nextAssignment.attemptsUsed, 0),
    gradeSynced,
    bestScore: committedBestScore,
    status: committedAssignmentStatus,
  };
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ assignmentId: string }> },
) {
  try {
    const { assignmentId } = await context.params;
    const normalizedAssignmentId = assignmentId.trim();
    if (!normalizedAssignmentId) {
      return NextResponse.json(
        { success: false, error: "assignmentId es requerido" },
        { status: 400 },
      );
    }

    const loaded = await loadAssignmentContext(request, normalizedAssignmentId);
    if ("error" in loaded) return loaded.error;

    let { access, assignmentRef, assignment, template } = loaded;
    let session = getAttemptSessionFromAssignment(assignment);

    if (access.role === "student") {
      const ensured = await ensureStudentAttemptSession({
        assignmentId: normalizedAssignmentId,
        assignmentRef,
      });

      assignment = ensured.assignment;
      session = ensured.session;

      if (ensured.expired) {
        await finalizeGlobalExamAttempt({
          assignmentId: normalizedAssignmentId,
          assignmentRef,
          assignment,
          template,
          access,
          answers: {},
          completionReason: "timeout",
        });

        const refreshed = await loadAssignmentContext(request, normalizedAssignmentId);
        if ("error" in refreshed) return refreshed.error;
        access = refreshed.access;
        assignmentRef = refreshed.assignmentRef;
        assignment = refreshed.assignment;
        template = refreshed.template;
        session = getAttemptSessionFromAssignment(assignment);
      }
    }

    const attemptsSnap = await assignmentRef.collection("attempts").orderBy("attemptNumber", "asc").get();
    const attempts = attemptsSnap.docs.map((docSnap) =>
      toGlobalExamAttemptRecord(docSnap.id, assignment.id, docSnap.data() ?? {}),
    );

    if (
      access.role === "student" &&
      (!assignment.enabled || assignment.status !== "enabled" || assignment.attemptsUsed >= assignment.attemptsAllowed)
    ) {
      return NextResponse.json(
        {
          success: false,
          error: "El examen no esta disponible para responder en este momento",
          data: {
            assignment,
            attempts,
          },
        },
        { status: 400 },
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        assignment,
        template: {
          id: template.id,
          title: template.title,
          description: template.description,
          courseId: template.courseId,
          courseName: template.courseName,
          questionCount: template.questionCount,
          passScore: template.passScore,
          maxAttempts: template.maxAttempts,
        },
        questions: sanitizeGlobalExamQuestionsForStudent(template.questions),
        attempts,
        session: {
          durationMinutes: GLOBAL_EXAM_DURATION_MINUTES,
          startedAt:
            session?.startedAt.toISOString() ??
            new Date().toISOString(),
          deadlineAt:
            session?.deadlineAt.toISOString() ??
            new Date(Date.now() + GLOBAL_EXAM_DURATION_MINUTES * 60_000).toISOString(),
        },
      },
    });
  } catch (error) {
    return toGlobalExamRouteErrorResponse(error, "Error preparando intento de examen global");
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ assignmentId: string }> },
) {
  try {
    const { assignmentId } = await context.params;
    const normalizedAssignmentId = assignmentId.trim();
    if (!normalizedAssignmentId) {
      return NextResponse.json(
        { success: false, error: "assignmentId es requerido" },
        { status: 400 },
      );
    }

    const access = await requireGlobalExamAccess(request, ["student"]);
    const db = getAdminFirestore();
    const assignmentRef = db.collection("globalExamAssignments").doc(normalizedAssignmentId);
    const assignmentSnap = await assignmentRef.get();
    if (!assignmentSnap.exists) {
      return NextResponse.json(
        { success: false, error: "No se encontro la asignacion solicitada" },
        { status: 404 },
      );
    }

    const assignment = toGlobalExamAssignmentRecord(normalizedAssignmentId, assignmentSnap.data() ?? {});
    if (assignment.studentId !== access.uid) {
      return NextResponse.json(
        { success: false, error: "No puedes responder un examen que no es tuyo" },
        { status: 403 },
      );
    }

    const templateSnap = await db.collection("globalExamTemplates").doc(assignment.templateId).get();
    if (!templateSnap.exists) {
      return NextResponse.json(
        { success: false, error: "La plantilla asociada ya no existe" },
        { status: 404 },
      );
    }
    const template = toGlobalExamTemplateRecord(templateSnap.id, templateSnap.data() ?? {});

    const body = (await request.json().catch(() => ({}))) as {
      answers?: unknown;
      completionReason?: unknown;
    };
    const completionReason =
      typeof body.completionReason === "string" && ATTEMPT_COMPLETION_REASONS.has(body.completionReason as GlobalExamAttemptCompletionReason)
        ? (body.completionReason as GlobalExamAttemptCompletionReason)
        : "submitted";

    const finalized = await finalizeGlobalExamAttempt({
      assignmentId: normalizedAssignmentId,
      assignmentRef,
      assignment,
      template,
      access,
      answers:
        body.answers && typeof body.answers === "object" && !Array.isArray(body.answers)
          ? (body.answers as Record<string, string>)
          : {},
      completionReason,
    });

    return NextResponse.json({
      success: true,
      data: finalized,
    });
  } catch (error) {
    if (error instanceof AttemptRouteError) {
      return NextResponse.json(
        {
          success: false,
          error: error.message,
        },
        { status: error.status },
      );
    }
    return toGlobalExamRouteErrorResponse(error, "Error enviando intento de examen global");
  }
}
