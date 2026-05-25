import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import {
  requireAdminTeacherAccess,
  toAdminTeacherRouteErrorResponse,
} from "@/lib/server/require-admin-teacher-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type UpdatePasswordRequest = {
  teacherId?: string;
  currentEmail?: string;
  newPassword?: string;
};

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeEmail(value: unknown): string {
  return normalizeText(value).toLowerCase();
}

export async function POST(request: NextRequest) {
  try {
    await requireAdminTeacherAccess(request);
    const body = (await request.json().catch(() => ({}))) as UpdatePasswordRequest;

    const teacherId = normalizeText(body.teacherId);
    const currentEmail = normalizeEmail(body.currentEmail);
    const newPassword = normalizeText(body.newPassword);

    if (!teacherId || !newPassword) {
      return NextResponse.json(
        { success: false, error: "teacherId y newPassword son requeridos" },
        { status: 400 },
      );
    }

    if (newPassword.length < 6) {
      return NextResponse.json(
        { success: false, error: "La contraseña debe tener al menos 6 caracteres" },
        { status: 400 },
      );
    }

    const auth = getAdminAuth();
    const userRecord = await auth.getUser(teacherId);
    if (currentEmail && normalizeEmail(userRecord.email) !== currentEmail) {
      return NextResponse.json(
        { success: false, error: "El email actual no coincide con el usuario indicado" },
        { status: 400 },
      );
    }

    await auth.updateUser(teacherId, {
      password: newPassword,
    });

    return NextResponse.json({
      success: true,
      message: "Contraseña actualizada correctamente",
    });
  } catch (error) {
    return toAdminTeacherRouteErrorResponse(error, "Error en teachers/update-password");
  }
}
