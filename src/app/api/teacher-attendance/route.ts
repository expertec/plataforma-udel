import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminFirestore } from "@/lib/firebase/admin";
import {
  requireTeacherAccess,
  toTeacherAccessErrorResponse,
} from "@/lib/server/require-teacher-access";
import {
  FaceVerificationError,
  loadTeacherFaceProfileStatus,
  verifyTeacherFace,
} from "@/lib/teacher-attendance/face-verification";
import type {
  TeacherAttendanceLocation,
  TeacherAttendanceRecord,
} from "@/lib/teacher-attendance/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CheckInBody = {
  faceDescriptor?: unknown;
  location?: unknown;
};

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toIsoString(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value.trim() : parsed.toISOString();
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
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

function recordsCollection(teacherId: string) {
  return getAdminFirestore()
    .collection("teacherAttendance")
    .doc(teacherId)
    .collection("records");
}

function mapRecord(
  docSnap: FirebaseFirestore.QueryDocumentSnapshot | FirebaseFirestore.DocumentSnapshot,
): TeacherAttendanceRecord {
  const data = (docSnap.data() ?? {}) as Record<string, unknown>;
  const checkInLocation = parseLocation(data.checkInLocation) ?? {
    latitude: 0,
    longitude: 0,
    accuracy: null,
  };
  const rawFaceVerification =
    data.faceVerification && typeof data.faceVerification === "object" && !Array.isArray(data.faceVerification)
      ? (data.faceVerification as Record<string, unknown>)
      : {};

  return {
    id: docSnap.id,
    teacherId: asTrimmedString(data.teacherId),
    teacherName: asTrimmedString(data.teacherName) || "Profesor",
    teacherEmail: asTrimmedString(data.teacherEmail) || null,
    teacherRole:
      data.teacherRole === "adminTeacher" ||
      data.teacherRole === "superAdminTeacher" ||
      data.teacherRole === "coordinadorPlantel" ||
      data.teacherRole === "director"
        ? data.teacherRole
        : "teacher",
    status: data.status === "closed" ? "closed" : "open",
    checkInAt: toIsoString(data.checkInAt) ?? "",
    checkOutAt: toIsoString(data.checkOutAt),
    checkInLocation,
    checkOutLocation: parseLocation(data.checkOutLocation),
    faceVerification: {
      status: rawFaceVerification.status === "rejected" ? "rejected" : "verified",
      provider: asTrimmedString(rawFaceVerification.provider) || "external",
      confidence:
        typeof rawFaceVerification.confidence === "number" &&
        Number.isFinite(rawFaceVerification.confidence)
          ? rawFaceVerification.confidence
          : null,
      checkedAt: toIsoString(rawFaceVerification.checkedAt) ?? "",
      reason: asTrimmedString(rawFaceVerification.reason) || null,
    },
    createdAt: toIsoString(data.createdAt),
    updatedAt: toIsoString(data.updatedAt),
  };
}

function toFaceVerificationErrorResponse(error: FaceVerificationError) {
  return NextResponse.json(
    {
      success: false,
      error: error.message,
    },
    { status: error.status },
  );
}

export async function GET(request: NextRequest) {
  try {
    const teacher = await requireTeacherAccess(request);
    const recordsRef = recordsCollection(teacher.uid);
    const [activeSnap, recentSnap, faceProfile] = await Promise.all([
      recordsRef.where("status", "==", "open").limit(1).get(),
      recordsRef.orderBy("checkInAt", "desc").limit(15).get(),
      loadTeacherFaceProfileStatus(teacher.uid),
    ]);

    return NextResponse.json(
      {
        success: true,
        data: {
          activeRecord: activeSnap.empty ? null : mapRecord(activeSnap.docs[0]),
          recentRecords: recentSnap.docs.map(mapRecord),
          hasFaceProfile: faceProfile.hasFaceProfile,
        },
      },
      { status: 200 },
    );
  } catch (error) {
    return toTeacherAccessErrorResponse(error, "Error cargando asistencia del profesor");
  }
}

export async function POST(request: NextRequest) {
  try {
    const teacher = await requireTeacherAccess(request);
    const body = (await request.json()) as CheckInBody;
    const location = parseLocation(body.location);
    if (!location) {
      return NextResponse.json(
        { success: false, error: "Se requiere una ubicacion valida para registrar entrada" },
        { status: 400 },
      );
    }

    const checkedAtIso = new Date().toISOString();
    const faceVerification = await verifyTeacherFace({
      teacher,
      faceDescriptor: body.faceDescriptor,
      checkedAtIso,
    });

    const recordsRef = recordsCollection(teacher.uid);
    const recordRef = recordsRef.doc();
    const createdRecord = await getAdminFirestore().runTransaction(async (transaction) => {
      const activeSnap = await transaction.get(recordsRef.where("status", "==", "open").limit(1));
      if (!activeSnap.empty) {
        throw new Error("Ya tienes una entrada abierta. Registra salida antes de iniciar otra.");
      }

      transaction.set(recordRef, {
        teacherId: teacher.uid,
        teacherName: teacher.displayName,
        teacherEmail: teacher.email,
        teacherRole: teacher.role,
        status: "open",
        checkInAt: checkedAtIso,
        checkOutAt: null,
        checkInLocation: location,
        checkOutLocation: null,
        faceVerification,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      return {
        id: recordRef.id,
        teacherId: teacher.uid,
        teacherName: teacher.displayName,
        teacherEmail: teacher.email,
        teacherRole: teacher.role,
        status: "open" as const,
        checkInAt: checkedAtIso,
        checkOutAt: null,
        checkInLocation: location,
        checkOutLocation: null,
        faceVerification,
        createdAt: null,
        updatedAt: null,
      };
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          record: createdRecord,
          hasFaceProfile: true,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof FaceVerificationError) {
      return toFaceVerificationErrorResponse(error);
    }
    if (error instanceof Error && error.message.includes("entrada abierta")) {
      return NextResponse.json({ success: false, error: error.message }, { status: 409 });
    }
    return toTeacherAccessErrorResponse(error, "Error registrando entrada del profesor");
  }
}
