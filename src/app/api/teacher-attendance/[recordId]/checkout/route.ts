import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminFirestore } from "@/lib/firebase/admin";
import {
  requireTeacherAccess,
  toTeacherAccessErrorResponse,
} from "@/lib/server/require-teacher-access";
import type { TeacherAttendanceLocation } from "@/lib/teacher-attendance/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CheckOutBody = {
  location?: unknown;
};

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseLocation(value: unknown): TeacherAttendanceLocation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const latitude = asFiniteNumber(candidate.latitude);
  const longitude = asFiniteNumber(candidate.longitude);
  const accuracy = asFiniteNumber(candidate.accuracy);

  if (latitude === null || longitude === null) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;

  return {
    latitude,
    longitude,
    accuracy: accuracy !== null && accuracy >= 0 ? accuracy : null,
  };
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ recordId: string }> },
) {
  try {
    const teacher = await requireTeacherAccess(request);
    const { recordId } = await context.params;
    const normalizedRecordId = typeof recordId === "string" ? recordId.trim() : "";
    if (!normalizedRecordId) {
      return NextResponse.json(
        { success: false, error: "Registro de asistencia requerido" },
        { status: 400 },
      );
    }

    const body = (await request.json()) as CheckOutBody;
    const location = parseLocation(body.location);
    if (!location) {
      return NextResponse.json(
        { success: false, error: "Se requiere una ubicacion valida para registrar salida" },
        { status: 400 },
      );
    }

    const recordRef = getAdminFirestore()
      .collection("teacherAttendance")
      .doc(teacher.uid)
      .collection("records")
      .doc(normalizedRecordId);
    const checkedOutAtIso = new Date().toISOString();

    await getAdminFirestore().runTransaction(async (transaction) => {
      const snap = await transaction.get(recordRef);
      if (!snap.exists) {
        throw new Error("Registro de asistencia no encontrado");
      }
      const data = (snap.data() ?? {}) as Record<string, unknown>;
      if (data.status === "closed") {
        throw new Error("Este registro ya tiene salida");
      }
      transaction.set(
        recordRef,
        {
          status: "closed",
          checkOutAt: checkedOutAtIso,
          checkOutLocation: location,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          recordId: normalizedRecordId,
          checkOutAt: checkedOutAtIso,
          checkOutLocation: location,
        },
      },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("Registro de asistencia")) {
      return NextResponse.json({ success: false, error: error.message }, { status: 404 });
    }
    if (error instanceof Error && error.message.includes("ya tiene salida")) {
      return NextResponse.json({ success: false, error: error.message }, { status: 409 });
    }
    return toTeacherAccessErrorResponse(error, "Error registrando salida del profesor");
  }
}
