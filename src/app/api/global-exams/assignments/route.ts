import { NextRequest, NextResponse } from "next/server";
import { getAdminFirestore } from "@/lib/firebase/admin";
import type { GlobalExamAssignmentReason } from "@/lib/global-exams/types";
import {
  getGlobalExamAssignments,
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

    if (!templateId || !studentId || !requestedGroupId) {
      return NextResponse.json(
        { success: false, error: "templateId, studentId y groupId son requeridos" },
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

    const enrollments = await resolveStudentCourseEnrollments(
      studentId,
      template.courseId,
      coordinatorScopeGroupIds,
    );
    const targetEnrollment = enrollments.find((enrollment) => enrollment.groupId === requestedGroupId);
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

    const existingAssignmentsSnap = await db
      .collection("globalExamAssignments")
      .where("studentId", "==", studentId)
      .get();
    const duplicated = existingAssignmentsSnap.docs.find((docSnap) => {
      const data = docSnap.data();
      if (asTrimmedString(data.groupId) !== targetEnrollment.groupId) return false;
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
            ? "Ya existe una asignacion de examen global para este alumno en esa materia y grupo"
            : "Ya existe una asignacion de esta plantilla para este alumno en ese grupo",
        },
        { status: 409 },
      );
    }

    const studentData = studentSnap.data() ?? {};
    const studentName =
      asTrimmedString(studentData.displayName) ||
      asTrimmedString(studentData.name) ||
      "Alumno";
    const studentEmail = asTrimmedString(studentData.email);
    const actorName = access.displayName || access.email || "Coordinacion";
    const now = new Date();

    const assignmentRef = await db.collection("globalExamAssignments").add({
      templateId: template.id,
      templateTitle: template.title,
      courseId: template.courseId,
      courseName: template.courseName,
      groupId: targetEnrollment.groupId,
      groupName: targetEnrollment.groupName,
      plantelId: targetEnrollment.plantelId,
      plantelName: targetEnrollment.plantelName,
      studentId,
      studentName,
      studentEmail,
      reason,
      enabled: requestedEnabled,
      status: requestedEnabled ? "enabled" : "draft",
      attemptsAllowed: template.maxAttempts,
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

    const createdSnap = await assignmentRef.get();
    return NextResponse.json({
      success: true,
      data: toGlobalExamAssignmentRecord(assignmentRef.id, createdSnap.data() ?? {}),
    });
  } catch (error) {
    return toGlobalExamRouteErrorResponse(error, "Error creando asignacion de examen global");
  }
}
