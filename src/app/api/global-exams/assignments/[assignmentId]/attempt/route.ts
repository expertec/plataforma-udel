import { NextRequest, NextResponse } from "next/server";
import { getAdminFirestore } from "@/lib/firebase/admin";
import {
  calculateGlobalExamResult,
  sanitizeGlobalExamQuestionsForStudent,
} from "@/lib/global-exams/types";
import {
  canAccessGlobalExamAssignment,
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

    const { access, assignmentRef, assignment, template } = loaded;
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
    };
    const result = calculateGlobalExamResult(template.questions, body.answers, assignment.passScore);
    const actorName = access.displayName || access.email || "Alumno";
    const now = new Date();
    const attemptRef = assignmentRef.collection("attempts").doc();

    let committedAttemptNumber = 0;
    let committedAssignmentStatus = assignment.status;
    let committedBestScore: number | null = assignment.bestScore;

    await db.runTransaction(async (transaction) => {
      const freshAssignmentSnap = await transaction.get(assignmentRef);
      if (!freshAssignmentSnap.exists) {
        throw new Error("La asignacion ya no existe");
      }

      const freshAssignment = toGlobalExamAssignmentRecord(
        normalizedAssignmentId,
        freshAssignmentSnap.data() ?? {},
      );

      if (!freshAssignment.enabled || freshAssignment.status !== "enabled") {
        throw new AttemptRouteError(400, "El examen ya no esta habilitado");
      }

      if (freshAssignment.attemptsUsed >= freshAssignment.attemptsAllowed) {
        throw new AttemptRouteError(400, "Ya no tienes intentos disponibles para este examen");
      }

      committedAttemptNumber = freshAssignment.attemptsUsed + 1;
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
        submittedAt: now,
      });

      transaction.set(
        assignmentRef,
        {
          attemptsUsed: committedAttemptNumber,
          latestScore: result.score,
          bestScore: nextBestScore,
          latestAttemptNumber: committedAttemptNumber,
          latestAttemptId: attemptRef.id,
          passed: result.passed,
          enabled: nextStatus === "enabled",
          status: nextStatus,
          updatedById: access.uid,
          updatedByName: actorName,
          updatedAt: now,
        },
        { merge: true },
      );
    });

    // Solo se sincroniza a kardex si hay materia y grupo (inscripcion destino).
    // Sin grupo, el resultado queda en la asignacion pero no se ata a una nota.
    let gradeSynced = !assignment.courseId || !assignment.groupId;
    if (assignment.courseId && assignment.groupId) {
      try {
        await syncGlobalExamGradeToEnrollments({
          assignmentId: assignment.id,
          studentId: assignment.studentId,
          studentName: assignment.studentName,
          studentEmail: assignment.studentEmail,
          groupId: assignment.groupId,
          groupName: assignment.groupName,
          courseId: assignment.courseId,
          courseName: assignment.courseName,
          plantelId: assignment.plantelId,
          plantelName: assignment.plantelName,
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

    const nextAssignmentSnap = await assignmentRef.get();
    const nextAssignment = toGlobalExamAssignmentRecord(normalizedAssignmentId, nextAssignmentSnap.data() ?? {});

    return NextResponse.json({
      success: true,
      data: {
        attempt: {
          id: attemptRef.id,
          attemptNumber: committedAttemptNumber,
          score: result.score,
          passed: result.passed,
          correctAnswers: result.correctAnswers,
          totalQuestions: result.totalQuestions,
        },
        assignment: nextAssignment,
        attemptsRemaining: Math.max(nextAssignment.attemptsAllowed - nextAssignment.attemptsUsed, 0),
        gradeSynced,
        bestScore: committedBestScore,
        status: committedAssignmentStatus,
      },
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
