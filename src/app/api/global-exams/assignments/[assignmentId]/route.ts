import { NextRequest, NextResponse } from "next/server";
import { getAdminFirestore } from "@/lib/firebase/admin";
import {
  canAccessGlobalExamAssignment,
  toGlobalExamAssignmentRecord,
} from "@/lib/server/global-exams";
import {
  getCoordinatorScopeGroupIds,
  requireGlobalExamAccess,
  toGlobalExamRouteErrorResponse,
} from "@/lib/server/global-exams-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ assignmentId: string }> },
) {
  try {
    const access = await requireGlobalExamAccess(request, [
      "coordinadorPlantel",
      "adminTeacher",
      "superAdminTeacher",
    ]);
    const { assignmentId } = await context.params;
    const normalizedAssignmentId = assignmentId.trim();
    if (!normalizedAssignmentId) {
      return NextResponse.json(
        { success: false, error: "assignmentId es requerido" },
        { status: 400 },
      );
    }

    const body = (await request.json().catch(() => ({}))) as {
      enabled?: unknown;
    };
    if (body.enabled !== true && body.enabled !== false) {
      return NextResponse.json(
        { success: false, error: "Debes enviar enabled como boolean" },
        { status: 400 },
      );
    }

    const assignmentRef = getAdminFirestore().collection("globalExamAssignments").doc(normalizedAssignmentId);
    const assignmentSnap = await assignmentRef.get();
    if (!assignmentSnap.exists) {
      return NextResponse.json(
        { success: false, error: "No se encontro la asignacion solicitada" },
        { status: 404 },
      );
    }

    const assignment = toGlobalExamAssignmentRecord(normalizedAssignmentId, assignmentSnap.data() ?? {});
    const coordinatorScopeGroupIds =
      access.role === "coordinadorPlantel"
        ? new Set(await getCoordinatorScopeGroupIds(access.uid, access.plantelIds))
        : new Set<string>();

    if (!canAccessGlobalExamAssignment(access, assignment, coordinatorScopeGroupIds)) {
      return NextResponse.json(
        { success: false, error: "No tienes permisos sobre esta asignacion" },
        { status: 403 },
      );
    }

    const requestedEnabled = body.enabled === true;
    if (requestedEnabled && (assignment.status === "passed" || assignment.status === "failed")) {
      return NextResponse.json(
        {
          success: false,
          error: "La asignacion ya fue concluida; no puede volver a habilitarse",
        },
        { status: 400 },
      );
    }

    const actorName = access.displayName || access.email || "Coordinacion";
    const now = new Date();
    const nextStatus = requestedEnabled ? "enabled" : assignment.attemptsUsed > 0 ? "disabled" : "draft";
    const updatePayload: Record<string, unknown> = {
      enabled: requestedEnabled,
      status: nextStatus,
      updatedById: access.uid,
      updatedByName: actorName,
      updatedAt: now,
    };
    if (requestedEnabled) {
      updatePayload.paymentVerifiedAt = now;
      updatePayload.enabledAt = now;
      updatePayload.enabledById = access.uid;
      updatePayload.enabledByName = actorName;
    }

    await assignmentRef.set(updatePayload, { merge: true });

    const nextSnap = await assignmentRef.get();
    return NextResponse.json({
      success: true,
      data: toGlobalExamAssignmentRecord(normalizedAssignmentId, nextSnap.data() ?? {}),
    });
  } catch (error) {
    return toGlobalExamRouteErrorResponse(error, "Error actualizando asignacion de examen global");
  }
}
