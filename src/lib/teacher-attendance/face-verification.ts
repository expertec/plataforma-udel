import { getAdminFirestore } from "@/lib/firebase/admin";
import type { TeacherAccessContext } from "@/lib/server/require-teacher-access";
import {
  calculateFaceDescriptorDistance,
  distanceToConfidence,
  FACE_MATCH_DISTANCE_THRESHOLD,
  normalizeFaceDescriptor,
} from "@/lib/teacher-attendance/face-descriptor";
import type { TeacherFaceVerification } from "@/lib/teacher-attendance/types";

export class FaceVerificationError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function loadTeacherFaceProfileStatus(teacherId: string): Promise<{
  hasFaceProfile: boolean;
}> {
  const snap = await getAdminFirestore().collection("teacherAttendance").doc(teacherId).get();
  return {
    hasFaceProfile: Boolean(normalizeFaceDescriptor(snap.data()?.faceDescriptor)),
  };
}

export async function verifyTeacherFace(params: {
  teacher: TeacherAccessContext;
  faceDescriptor: unknown;
  checkedAtIso: string;
}): Promise<TeacherFaceVerification> {
  const checkInDescriptor = normalizeFaceDescriptor(params.faceDescriptor);
  if (!checkInDescriptor) {
    throw new FaceVerificationError(400, "Se requiere un descriptor facial valido");
  }

  const faceProfileSnap = await getAdminFirestore()
    .collection("teacherAttendance")
    .doc(params.teacher.uid)
    .get();
  const storedDescriptor = normalizeFaceDescriptor(faceProfileSnap.data()?.faceDescriptor);
  if (!storedDescriptor) {
    throw new FaceVerificationError(
      409,
      "Registra tu perfil facial antes de hacer check-in",
    );
  }

  const distance = calculateFaceDescriptorDistance(storedDescriptor, checkInDescriptor);
  const verified = distance <= FACE_MATCH_DISTANCE_THRESHOLD;
  const verification: TeacherFaceVerification = {
    status: verified ? "verified" : "rejected",
    provider: "@vladmandic/face-api",
    confidence: distanceToConfidence(distance),
    checkedAt: params.checkedAtIso,
    reason: verified
      ? `Distancia facial ${distance.toFixed(4)}`
      : `Distancia facial ${distance.toFixed(4)} superior al umbral`,
  };

  if (!verified) {
    throw new FaceVerificationError(
      403,
      "No se pudo validar que la captura corresponda al profesor",
    );
  }

  return verification;
}
