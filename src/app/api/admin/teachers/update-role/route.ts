import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";
import {
  requireAdminTeacher,
  toRouteErrorResponse,
} from "@/lib/server/require-super-admin-teacher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ManageableRole = "teacher" | "adminTeacher" | "coordinadorPlantel";

type UpdateTeacherRoleRequest = {
  teacherId?: string;
  newRole?: ManageableRole;
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

    if (adminContext.uid === teacherId && body.newRole !== "adminTeacher") {
      return NextResponse.json(
        { success: false, error: "No puedes cambiar tu propio rol desde este panel" },
        { status: 400 },
      );
    }

    const auth = getAdminAuth();
    const firestore = getAdminFirestore();
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

    if (currentRole === body.newRole) {
      return NextResponse.json(
        {
          success: true,
          changed: false,
          role: currentRole,
        },
        { status: 200 },
      );
    }

    await userRef.set(
      {
        role: body.newRole,
        updatedAt: new Date(),
        updatedBy: adminContext.uid,
      },
      { merge: true },
    );

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
