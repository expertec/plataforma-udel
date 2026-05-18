import { NextRequest, NextResponse } from "next/server";
import * as admin from "firebase-admin";
import { getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";
import {
  requireAdminTeacher,
  RouteAccessError,
  toRouteErrorResponse,
} from "@/lib/server/require-super-admin-teacher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ManageableRole = "teacher" | "adminTeacher" | "coordinadorPlantel";

type UpdateTeacherRoleRequest = {
  teacherId?: string;
  newRole?: ManageableRole;
  plantelIds?: string[] | null;
  plantelNames?: string[] | null;
  plantelId?: string | null;
  plantelName?: string | null;
};

const MANAGEABLE_ROLES: ManageableRole[] = [
  "teacher",
  "adminTeacher",
  "coordinadorPlantel",
];

function isManageableRole(value: unknown): value is ManageableRole {
  return (
    typeof value === "string" &&
    MANAGEABLE_ROLES.includes(value as ManageableRole)
  );
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asTextArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
}

type PlantelAssignmentInput = {
  plantelId: string;
  plantelName: string;
};

function dedupePlantelAssignments(
  assignments: PlantelAssignmentInput[],
): PlantelAssignmentInput[] {
  const map = new Map<string, PlantelAssignmentInput>();
  assignments.forEach((assignment) => {
    if (!assignment.plantelId) return;
    const existing = map.get(assignment.plantelId);
    if (!existing) {
      map.set(assignment.plantelId, assignment);
      return;
    }
    if (!existing.plantelName && assignment.plantelName) {
      map.set(assignment.plantelId, assignment);
    }
  });
  return Array.from(map.values());
}

function getAssignmentsFromUserData(data: Record<string, unknown>): PlantelAssignmentInput[] {
  const plantelIds = asTextArray(data.plantelIds);
  const plantelNames = Array.isArray(data.plantelNames)
    ? data.plantelNames.map((item) => (typeof item === "string" ? item.trim() : ""))
    : [];
  if (plantelIds.length > 0) {
    return dedupePlantelAssignments(
      plantelIds.map((plantelId, index) => ({
        plantelId,
        plantelName: plantelNames[index] ?? "",
      })),
    );
  }

  const legacyPlantelId = asText(data.plantelId);
  if (!legacyPlantelId) return [];
  return [
    {
      plantelId: legacyPlantelId,
      plantelName: asText(data.plantelName) ?? "",
    },
  ];
}

function getRequestedAssignments(body: UpdateTeacherRoleRequest): PlantelAssignmentInput[] {
  const plantelIds = asTextArray(body.plantelIds);
  const plantelNames = Array.isArray(body.plantelNames)
    ? body.plantelNames.map((item) => (typeof item === "string" ? item.trim() : ""))
    : [];
  if (plantelIds.length > 0) {
    return dedupePlantelAssignments(
      plantelIds.map((plantelId, index) => ({
        plantelId,
        plantelName: plantelNames[index] ?? "",
      })),
    );
  }

  const plantelId = asText(body.plantelId);
  if (!plantelId) return [];
  return [
    {
      plantelId,
      plantelName: asText(body.plantelName) ?? "",
    },
  ];
}

function buildAssignmentUpdateData(assignments: PlantelAssignmentInput[]): Record<string, unknown> {
  const nextAssignments = dedupePlantelAssignments(assignments);
  const primaryAssignment = nextAssignments[0] ?? null;
  return {
    plantelIds: nextAssignments.map((assignment) => assignment.plantelId),
    plantelNames: nextAssignments.map((assignment) => assignment.plantelName),
    plantelId: primaryAssignment?.plantelId ?? admin.firestore.FieldValue.delete(),
    plantelName: primaryAssignment?.plantelName ?? admin.firestore.FieldValue.delete(),
  };
}

function areAssignmentsEqual(
  left: PlantelAssignmentInput[],
  right: PlantelAssignmentInput[],
): boolean {
  if (left.length !== right.length) return false;
  const leftSorted = [...left].sort((a, b) => a.plantelId.localeCompare(b.plantelId, "es"));
  const rightSorted = [...right].sort((a, b) => a.plantelId.localeCompare(b.plantelId, "es"));
  return leftSorted.every((assignment, index) => {
    const other = rightSorted[index];
    return (
      assignment.plantelId === other?.plantelId &&
      assignment.plantelName === other?.plantelName
    );
  });
}

export async function POST(request: NextRequest) {
  try {
    const adminContext = await requireAdminTeacher(request);
    const body = (await request.json().catch(() => ({}))) as UpdateTeacherRoleRequest;
    const teacherId = body?.teacherId?.trim();

    if (!teacherId) {
      return NextResponse.json(
        { success: false, error: "teacherId es requerido" },
        { status: 400 },
      );
    }

    if (!isManageableRole(body?.newRole)) {
      return NextResponse.json(
        { success: false, error: "newRole inválido" },
        { status: 400 },
      );
    }

    const rawRequestedAssignments = getRequestedAssignments(body);
    if (body.newRole === "coordinadorPlantel" && rawRequestedAssignments.length === 0) {
      return NextResponse.json(
        { success: false, error: "Selecciona al menos un plantel para el coordinador" },
        { status: 400 },
      );
    }

    if (adminContext.uid === teacherId && body.newRole !== "adminTeacher") {
      return NextResponse.json(
        { success: false, error: "No puedes cambiar tu propio rol desde este panel" },
        { status: 400 },
      );
    }

    const auth = getAdminAuth();
    const firestore = getAdminFirestore();
    const resolvedRequestedAssignments = await Promise.all(
      rawRequestedAssignments.map(async (assignment) => {
        const plantelSnap = await firestore.collection("planteles").doc(assignment.plantelId).get();
        if (!plantelSnap.exists) {
          throw new RouteAccessError(400, `Plantel inválido: ${assignment.plantelId}`);
        }
        const plantelData = plantelSnap.data() ?? {};
        return {
          plantelId: assignment.plantelId,
          plantelName:
            assignment.plantelName ||
            asText(plantelData.name) ||
            asText(plantelData.nombre) ||
            "",
        };
      }),
    );
    const userRef = firestore.collection("users").doc(teacherId);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return NextResponse.json(
        { success: false, error: "Usuario no encontrado" },
        { status: 404 },
      );
    }

    const userRecord = await auth.getUser(teacherId);
    const roleFromDoc = asText(userSnap.data()?.role);
    const roleFromClaims = asText(userRecord.customClaims?.role);
    const currentRole = roleFromDoc ?? roleFromClaims;

    if (!currentRole) {
      return NextResponse.json(
        { success: false, error: "El usuario no tiene rol asignado" },
        { status: 400 },
      );
    }

    if (currentRole === "superAdminTeacher") {
      return NextResponse.json(
        { success: false, error: "No puedes modificar el rol de un SuperAdminTeacher" },
        { status: 403 },
      );
    }

    if (!isManageableRole(currentRole)) {
      return NextResponse.json(
        { success: false, error: `No puedes gestionar usuarios con rol ${currentRole}` },
        { status: 403 },
      );
    }

    const currentAssignments = getAssignmentsFromUserData(
      (userSnap.data() ?? {}) as Record<string, unknown>,
    );
    const plantelChanged =
      body.newRole === "coordinadorPlantel" &&
      !areAssignmentsEqual(currentAssignments, resolvedRequestedAssignments);

    if (currentRole === body.newRole && !plantelChanged) {
      return NextResponse.json(
        {
          success: true,
          changed: false,
          role: currentRole,
        },
        { status: 200 },
      );
    }

    const updateData: Record<string, unknown> = {
      role: body.newRole,
      updatedAt: new Date(),
      updatedBy: adminContext.uid,
    };
    if (body.newRole === "coordinadorPlantel") {
      Object.assign(updateData, buildAssignmentUpdateData(resolvedRequestedAssignments));
    } else {
      updateData.plantelId = admin.firestore.FieldValue.delete();
      updateData.plantelName = admin.firestore.FieldValue.delete();
      updateData.plantelIds = admin.firestore.FieldValue.delete();
      updateData.plantelNames = admin.firestore.FieldValue.delete();
    }

    await userRef.set(updateData, { merge: true });

    await auth.setCustomUserClaims(teacherId, {
      ...(userRecord.customClaims ?? {}),
      role: body.newRole,
    });

    return NextResponse.json(
      {
        success: true,
        changed: true,
        role: body.newRole,
      },
      { status: 200 },
    );
  } catch (error: unknown) {
    return toRouteErrorResponse(error, "Error actualizando rol de profesor");
  }
}
