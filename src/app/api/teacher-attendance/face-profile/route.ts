import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminFirestore } from "@/lib/firebase/admin";
import {
  requireTeacherAccess,
  toTeacherAccessErrorResponse,
} from "@/lib/server/require-teacher-access";
import { normalizeFaceDescriptor } from "@/lib/teacher-attendance/face-descriptor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type FaceProfileBody = {
  faceDescriptor?: unknown;
};

function toIsoString(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value.trim() : parsed.toISOString();
  }
  if (typeof value === "object" && value !== null) {
    const candidate = value as { toDate?: () => Date; toMillis?: () => number };
    if (typeof candidate.toDate === "function") {
      const date = candidate.toDate();
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
    if (typeof candidate.toMillis === "function") {
      const date = new Date(candidate.toMillis());
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
  }
  return null;
}

function faceProfileRef(teacherId: string) {
  return getAdminFirestore().collection("teacherAttendance").doc(teacherId);
}

export async function GET(request: NextRequest) {
  try {
    const teacher = await requireTeacherAccess(request);
    const snap = await faceProfileRef(teacher.uid).get();
    const data = (snap.data() ?? {}) as Record<string, unknown>;
    const descriptor = normalizeFaceDescriptor(data.faceDescriptor);

    return NextResponse.json(
      {
        success: true,
        data: {
          hasFaceProfile: Boolean(descriptor),
          enrolledAt: toIsoString(data.faceEnrolledAt),
          updatedAt: toIsoString(data.faceUpdatedAt),
        },
      },
      { status: 200 },
    );
  } catch (error) {
    return toTeacherAccessErrorResponse(error, "Error cargando perfil facial del profesor");
  }
}

export async function PUT(request: NextRequest) {
  try {
    const teacher = await requireTeacherAccess(request);
    const body = (await request.json()) as FaceProfileBody;
    const descriptor = normalizeFaceDescriptor(body.faceDescriptor);
    if (!descriptor) {
      return NextResponse.json(
        { success: false, error: "Descriptor facial invalido" },
        { status: 400 },
      );
    }

    const ref = faceProfileRef(teacher.uid);
    const snap = await ref.get();
    await ref.set(
      {
        teacherId: teacher.uid,
        teacherName: teacher.displayName,
        teacherEmail: teacher.email,
        faceDescriptor: descriptor,
        faceDescriptorModel: "@vladmandic/face-api",
        faceEnrolledAt: snap.exists ? snap.data()?.faceEnrolledAt ?? FieldValue.serverTimestamp() : FieldValue.serverTimestamp(),
        faceUpdatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return NextResponse.json(
      {
        success: true,
        data: {
          hasFaceProfile: true,
        },
      },
      { status: 200 },
    );
  } catch (error) {
    return toTeacherAccessErrorResponse(error, "Error guardando perfil facial del profesor");
  }
}
