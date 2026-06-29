import { NextRequest, NextResponse } from "next/server";
import { getAdminFirestore } from "@/lib/firebase/admin";
import { GLOBAL_EXAM_MAX_ATTEMPTS, type GlobalExamAssignmentReason } from "@/lib/global-exams/types";
import {
  getGlobalExamAssignments,
  ensureGlobalExamStudyEnrollment,
  resolveStudentCourseEnrollments,
  toGlobalExamAssignmentRecord,
  toGlobalExamTemplateRecord,
  canAccessGlobalExamAssignment,
} from "@/lib/server/global-exams";
import {
  getCoordinatorScopeGroupIds,
  requireGlobalExamAccess,
  toGlobalExamRouteErrorResponse,
} from "@/lib/server/global-exams-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeReason(value: unknown): GlobalExamAssignmentReason {
  return value === "late_joiner" ? "late_joiner" : "failed_course";
}

export async function GET(request: NextRequest) {
  try {
    const access = await requireGlobalExamAccess(request, [
      "student",
      "coordinadorPlantel",
      "director",
      "adminTeacher",
      "superAdminTeacher",
    ]);

    const assignments = await getGlobalExamAssignments();
    const coordinatorScopeGroupIds =
      access.role === "coordinadorPlantel" || access.role === "director"
        ? new Set(await getCoordinatorScopeGroupIds(access.uid, access.plantelIds))
        : new Set<string>();

    const visibleAssignments = assignments.filter((assignment) =>
      canAccessGlobalExamAssignment(access, assignment, coordinatorScopeGroupIds),
    );

    return NextResponse.json({
      success: true,
      data: visibleAssignments,
    });
  } catch (error) {
    return toGlobalExamRouteErrorResponse(error, "Error listando asignaciones de examen global");
  }
}

export async function POST(request: NextRequest) {
  try {
    const access = await requireGlobalExamAccess(request, [
      "coordinadorPlantel",
      "director",
      "adminTeacher",
      "superAdminTeacher",
    ]);
    const body = (await request.json().catch(() => ({}))) as {
      templateId?: unknown;
      studentId?: unknown;
      groupId?: unknown;
      reason?: unknown;
      enabled?: unknown;
    };

    const templateId = asTrimmedString(body.templateId);
    const studentId = asTrimmedString(body.studentId);
    const requestedGroupId = asTrimmedString(body.groupId);
    const reason = normalizeReason(body.reason);
    const requestedEnabled = body.enabled === true;

    if (!templateId || !studentId) {
      return NextResponse.json(
        { success: false, error: "templateId y studentId son requeridos" },
        { status: 400 },
      );
    }

    const db = getAdminFirestore();
    const [templateSnap, studentSnap] = await Promise.all([
      db.collection("globalExamTemplates").doc(templateId).get(),
      db.collection("users").doc(studentId).get(),
    ]);

    if (!templateSnap.exists) {
      return NextResponse.json(
        { success: false, error: "No se encontro la plantilla seleccionada" },
        { status: 404 },
      );
    }

    if (!studentSnap.exists) {
      return NextResponse.json(
        { success: false, error: "No se encontro el alumno seleccionado" },
        { status: 404 },
      );
    }

    const template = toGlobalExamTemplateRecord(templateSnap.id, templateSnap.data() ?? {});
    if (template.status !== "published") {
      return NextResponse.json(
        { success: false, error: "Solo puedes asignar plantillas publicadas" },
        { status: 400 },
      );
    }

    const coordinatorScopeGroupIds =
      access.role === "coordinadorPlantel" || access.role === "director"
        ? new Set(await getCoordinatorScopeGroupIds(access.uid, access.plantelIds))
        : undefined;

    const studentData = studentSnap.data() ?? {};

    // El grupo es opcional en la UI. Con grupo explicito: se valida la
    // inscripcion del alumno. Sin grupo: el servidor intenta resolver
    // automaticamente la inscripcion del alumno en la materia de la plantilla,
    // para que la nota se sincronice a kardex y se desbloquee el contenido en
    // modo estudio sin que el operador tenga que elegir el grupo a mano.
    let targetEnrollment:
      | Awaited<ReturnType<typeof resolveStudentCourseEnrollments>>[number]
      | null = null;

    if (requestedGroupId) {
      const enrollments = await resolveStudentCourseEnrollments(
        studentId,
        template.courseId,
        coordinatorScopeGroupIds,
        template.courseName,
      );
      targetEnrollment = enrollments.find((enrollment) => enrollment.groupId === requestedGroupId) ?? null;
      if (!targetEnrollment) {
        return NextResponse.json(
          {
            success: false,
            error: template.courseId
              ? "El alumno no tiene una inscripcion valida para esa materia dentro de ese grupo"
              : "El alumno no tiene una inscripcion valida dentro de ese grupo",
          },
          { status: 400 },
        );
      }
    } else if (template.courseId) {
      // Auto-resolver: si el alumno ya tiene inscripcion en la materia, la
      // usamos para que la nota se sincronice y el contenido se desbloquee.
      const enrollments = await resolveStudentCourseEnrollments(
        studentId,
        template.courseId,
        coordinatorScopeGroupIds,
        template.courseName,
      );
      targetEnrollment = enrollments[0] ?? null;
    }

    if (!targetEnrollment && coordinatorScopeGroupIds !== undefined) {
      // Sin inscripcion resuelta no hay alcance por grupo, asi que coordinacion
      // solo puede asignar a alumnos de su mismo plantel.
      const studentPlantelIds = Array.isArray(studentData.plantelIds)
        ? (studentData.plantelIds as unknown[]).map((value) => asTrimmedString(value)).filter(Boolean)
        : [asTrimmedString(studentData.plantelId)].filter(Boolean);
      const sharesPlantel = studentPlantelIds.some((plantelId) => access.plantelIds.includes(plantelId));
      if (!sharesPlantel) {
        return NextResponse.json(
          { success: false, error: "El alumno no pertenece a tu plantel" },
          { status: 403 },
        );
      }
    }

    let studyContextEnrollment = targetEnrollment;
    if (!studyContextEnrollment) {
      const activeEnrollments = await resolveStudentCourseEnrollments(
        studentId,
        undefined,
        coordinatorScopeGroupIds,
      );
      studyContextEnrollment = activeEnrollments[0] ?? null;
    }
    const resolvedGroupId = studyContextEnrollment?.groupId ?? "";

    const existingAssignmentsSnap = await db
      .collection("globalExamAssignments")
      .where("studentId", "==", studentId)
      .get();
    const duplicated = existingAssignmentsSnap.docs.find((docSnap) => {
      const data = docSnap.data();
      if (asTrimmedString(data.groupId) !== resolvedGroupId) return false;
      if (template.courseId) {
        return asTrimmedString(data.courseId) === template.courseId;
      }
      return asTrimmedString(data.templateId) === template.id;
    });
    if (duplicated) {
      return NextResponse.json(
        {
          success: false,
          error: template.courseId
            ? "Ya existe una asignacion de examen global para este alumno en esa materia"
            : "Ya existe una asignacion de esta plantilla para este alumno",
        },
        { status: 409 },
      );
    }

    const studentName =
      asTrimmedString(studentData.displayName) ||
      asTrimmedString(studentData.name) ||
      "Alumno";
    const studentEmail = asTrimmedString(studentData.email);
    const actorName = access.displayName || access.email || "Coordinacion";
    const now = new Date();

    // Sin grupo, tomamos el plantel del alumno para conservar contexto/visibilidad.
    const studentPlantelId = Array.isArray(studentData.plantelIds)
      ? asTrimmedString((studentData.plantelIds as unknown[])[0])
      : asTrimmedString(studentData.plantelId);
    const studentPlantelName = Array.isArray(studentData.plantelNames)
      ? asTrimmedString((studentData.plantelNames as unknown[])[0])
      : asTrimmedString(studentData.plantelName);

    const assignmentRef = await db.collection("globalExamAssignments").add({
      templateId: template.id,
      templateTitle: template.title,
      courseId: targetEnrollment?.courseId ?? template.courseId,
      courseName: targetEnrollment?.courseName ?? template.courseName,
      groupId: studyContextEnrollment?.groupId ?? "",
      groupName: studyContextEnrollment?.groupName ?? "",
      plantelId: studyContextEnrollment?.plantelId ?? studentPlantelId,
      plantelName: studyContextEnrollment?.plantelName ?? studentPlantelName,
      studentId,
      studentName,
      studentEmail,
      reason,
      enabled: requestedEnabled,
      status: requestedEnabled ? "enabled" : "draft",
      // Un solo intento por habilitacion; el adminTeacher puede conceder mas reabriendo.
      attemptsAllowed: GLOBAL_EXAM_MAX_ATTEMPTS,
      attemptsUsed: 0,
      passScore: template.passScore,
      latestScore: null,
      bestScore: null,
      latestAttemptNumber: 0,
      latestAttemptId: null,
      passed: false,
      paymentVerifiedAt: requestedEnabled ? now : null,
      enabledAt: requestedEnabled ? now : null,
      enabledById: requestedEnabled ? access.uid : null,
      enabledByName: requestedEnabled ? actorName : null,
      createdById: access.uid,
      createdByName: actorName,
      updatedById: access.uid,
      updatedByName: actorName,
      createdAt: now,
      updatedAt: now,
    });

    if (template.courseId) {
      await ensureGlobalExamStudyEnrollment({
        studentId,
        studentName,
        studentEmail,
        courseId: targetEnrollment?.courseId ?? template.courseId,
        courseName: targetEnrollment?.courseName ?? template.courseName,
        groupId: studyContextEnrollment?.groupId ?? "",
        groupName: studyContextEnrollment?.groupName ?? "Modo estudio",
        plantelId: studyContextEnrollment?.plantelId ?? studentPlantelId,
        plantelName: studyContextEnrollment?.plantelName ?? studentPlantelName,
        assignmentId: assignmentRef.id,
      });
    }

    const createdSnap = await assignmentRef.get();
    return NextResponse.json({
      success: true,
      data: toGlobalExamAssignmentRecord(assignmentRef.id, createdSnap.data() ?? {}),
    });
  } catch (error) {
    return toGlobalExamRouteErrorResponse(error, "Error creando asignacion de examen global");
  }
}
