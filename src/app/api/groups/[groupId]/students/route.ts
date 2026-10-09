import { NextRequest, NextResponse } from "next/server";
import * as admin from "firebase-admin";
import { getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";
import { isStudentStatusActive } from "@/lib/students/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AllowedRole = "teacher" | "coordinadorPlantel" | "director" | "adminTeacher" | "superAdminTeacher";

type GroupStudentPayload = {
  id: string;
  studentName: string;
  studentEmail: string;
  status: string;
  enrolledAtMs?: number;
};

class RouteAccessError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function extractBearerToken(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) return null;
  const trimmed = authorizationHeader.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
  const token = trimmed.slice(7).trim();
  return token || null;
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asUniqueStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value.filter((item): item is string => typeof item === "string" && item.trim().length > 0),
    ),
  );
}

function asAllowedRole(value: unknown): AllowedRole | null {
  return value === "teacher" ||
    value === "coordinadorPlantel" ||
    value === "director" ||
    value === "adminTeacher" ||
    value === "superAdminTeacher"
    ? value
    : null;
}

function isLegacyAdminTeacherRole(value: unknown): boolean {
  return (
    value === "adminteacher" ||
    value === "superadminteacher" ||
    value === "admin_teacher" ||
    value === "super_admin_teacher"
  );
}

function getUserPlantelIds(data: Record<string, unknown>): string[] {
  const plantelIds = asUniqueStringArray(data.plantelIds);
  if (plantelIds.length > 0) return plantelIds;
  const legacyPlantelId = asTrimmedString(data.plantelId);
  return legacyPlantelId ? [legacyPlantelId] : [];
}

function toMillis(value: unknown): number | undefined {
  if (!value) return undefined;
  if (value instanceof Date) {
    const millis = value.getTime();
    return Number.isFinite(millis) ? millis : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "object" && value !== null) {
    if ("toMillis" in value && typeof (value as { toMillis?: unknown }).toMillis === "function") {
      try {
        return (value as { toMillis: () => number }).toMillis();
      } catch {
        return undefined;
      }
    }
    if ("toDate" in value && typeof (value as { toDate?: unknown }).toDate === "function") {
      try {
        return (value as { toDate: () => Date }).toDate().getTime();
      } catch {
        return undefined;
      }
    }
    const seconds = (value as { seconds?: unknown }).seconds;
    const nanoseconds = (value as { nanoseconds?: unknown }).nanoseconds;
    if (typeof seconds === "number" && Number.isFinite(seconds)) {
      const nanos = typeof nanoseconds === "number" && Number.isFinite(nanoseconds) ? nanoseconds : 0;
      return Math.trunc(seconds * 1000 + nanos / 1_000_000);
    }
  }
  return undefined;
}

function compareStudentsByName(left: GroupStudentPayload, right: GroupStudentPayload): number {
  const nameCompare = (left.studentName || "Sin nombre").localeCompare(
    right.studentName || "Sin nombre",
    "es-MX",
    { numeric: true, sensitivity: "base" },
  );
  if (nameCompare !== 0) return nameCompare;

  const emailCompare = left.studentEmail.localeCompare(right.studentEmail, "es-MX", {
    numeric: true,
    sensitivity: "base",
  });
  if (emailCompare !== 0) return emailCompare;

  return left.id.localeCompare(right.id, "es-MX", { numeric: true, sensitivity: "base" });
}

type AccessContext = {
  uid: string;
  groupData: Record<string, unknown>;
};

async function resolveAccessContext(request: NextRequest, groupId: string): Promise<AccessContext> {
  const token = extractBearerToken(request.headers.get("authorization"));
  if (!token) {
    throw new RouteAccessError(401, "Authorization Bearer token requerido");
  }

  let decodedToken: Awaited<ReturnType<ReturnType<typeof getAdminAuth>["verifyIdToken"]>>;
  try {
    decodedToken = await getAdminAuth().verifyIdToken(token);
  } catch {
    throw new RouteAccessError(401, "Token inválido o expirado");
  }

  const uid = decodedToken.uid;
  const userSnap = await getAdminFirestore().collection("users").doc(uid).get();
  const userData = (userSnap.data() ?? {}) as Record<string, unknown>;
  const rawRole = userData.role ?? decodedToken.role;
  const role = asAllowedRole(rawRole);

  const groupSnap = await getAdminFirestore().collection("groups").doc(groupId).get();
  if (!groupSnap.exists) {
    throw new RouteAccessError(404, "Grupo no encontrado");
  }

  const groupData = (groupSnap.data() ?? {}) as Record<string, unknown>;
  const plantelIds = getUserPlantelIds(userData);
  const groupPlantelId = asTrimmedString(groupData.plantelId);
  const coordinatorId = asTrimmedString(groupData.coordinatorId);
  const teacherId = asTrimmedString(groupData.teacherId);
  const assistantTeacherIds = asUniqueStringArray(groupData.assistantTeacherIds);
  const isOnlineGroup =
    !(typeof groupData.isInPerson === "boolean" && groupData.isInPerson === true);

  const canRead =
    role === "adminTeacher" ||
    role === "superAdminTeacher" ||
    isLegacyAdminTeacherRole(rawRole) ||
    ((role === "teacher" || !role) && (teacherId === uid || assistantTeacherIds.includes(uid))) ||
    ((role === "coordinadorPlantel" || role === "director") &&
      ((groupPlantelId.length > 0 && plantelIds.includes(groupPlantelId)) ||
        (isOnlineGroup && coordinatorId === uid)));

  if (!canRead) {
    throw new RouteAccessError(403, "Missing or insufficient permissions.");
  }

  return {
    uid,
    groupData,
  };
}

function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof RouteAccessError) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: error.status },
    );
  }

  console.error("Error al obtener alumnos del grupo:", error);
  return NextResponse.json(
    { success: false, error: "Error interno del servidor" },
    { status: 500 },
  );
}

type RouteContext = {
  params?: { groupId?: string } | Promise<{ groupId?: string }>;
};

function resolveGroupId(request: NextRequest, context: RouteContext): Promise<string> {
  return Promise.resolve(context.params).then((resolvedParams) => {
    const groupIdFromParams = resolvedParams?.groupId?.trim() ?? "";
    const pathnameSegments = new URL(request.url).pathname.split("/").filter(Boolean);
    const groupIdFromPath =
      pathnameSegments[1] === "groups" && pathnameSegments[3] === "students"
        ? pathnameSegments[2]?.trim() ?? ""
        : "";
    return groupIdFromParams || groupIdFromPath;
  });
}

async function syncStudentPlantelAccess(studentId: string) {
  const firestore = getAdminFirestore();
  const enrollmentsSnap = await firestore
    .collection("studentEnrollments")
    .where("studentId", "==", studentId)
    .get();
  const plantelNameById = new Map<string, string>();

  enrollmentsSnap.docs.forEach((enrollmentDoc) => {
    const data = enrollmentDoc.data() as Record<string, unknown>;
    if (!isStudentStatusActive(asTrimmedString(data.status) || "active")) return;
    const plantelId = asTrimmedString(data.plantelId);
    if (!plantelId) return;
    plantelNameById.set(plantelId, asTrimmedString(data.plantelName));
  });

  await firestore.collection("users").doc(studentId).set(
    {
      plantelIds: Array.from(plantelNameById.keys()),
      plantelNames: Array.from(plantelNameById.values()).filter(Boolean),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const groupId = await resolveGroupId(request, context);
    if (!groupId) {
      throw new RouteAccessError(400, "groupId es requerido");
    }

    await resolveAccessContext(request, groupId);

    const studentsSnap = await getAdminFirestore()
      .collection("groups")
      .doc(groupId)
      .collection("students")
      .orderBy("enrolledAt", "desc")
      .get();

    const students: GroupStudentPayload[] = studentsSnap.docs
      .map((docSnap) => {
        const data = docSnap.data() as Record<string, unknown>;
        return {
          id: docSnap.id,
          studentName: asTrimmedString(data.studentName),
          studentEmail: asTrimmedString(data.studentEmail),
          status: asTrimmedString(data.status) || "active",
          enrolledAtMs: toMillis(data.enrolledAt),
        };
      })
      .filter((student) => isStudentStatusActive(student.status))
      .sort(compareStudentsByName);

    return NextResponse.json(
      {
        success: true,
        data: {
          students,
        },
      },
      { status: 200 },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const groupId = await resolveGroupId(request, context);
    if (!groupId) {
      throw new RouteAccessError(400, "groupId es requerido");
    }

    await resolveAccessContext(request, groupId);

    const body = (await request.json().catch(() => ({}))) as { studentId?: unknown };
    const studentId = asTrimmedString(body.studentId);
    if (!studentId) {
      throw new RouteAccessError(400, "studentId es requerido");
    }

    const firestore = getAdminFirestore();
    const groupRef = firestore.collection("groups").doc(groupId);
    const studentRef = groupRef.collection("students").doc(studentId);
    const studentSnap = await studentRef.get();

    const batch = firestore.batch();
    if (studentSnap.exists) {
      batch.delete(studentRef);
      batch.update(groupRef, {
        studentsCount: admin.firestore.FieldValue.increment(-1),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    const archivedAt = admin.firestore.FieldValue.serverTimestamp();
    const processedEnrollmentIds = new Set<string>();
    const archiveAndDeleteEnrollment = (
      enrollmentId: string,
      data: FirebaseFirestore.DocumentData | null,
    ) => {
      if (!enrollmentId || processedEnrollmentIds.has(enrollmentId)) return;
      processedEnrollmentIds.add(enrollmentId);
      const enrollmentRef = firestore.collection("studentEnrollments").doc(enrollmentId);
      if (data) {
        batch.set(firestore.collection("studentEnrollmentsArchive").doc(enrollmentId), {
          ...data,
          studentId,
          groupId: asTrimmedString(data.groupId) || groupId,
          archived: true,
          archivedAt,
          archivedFromGroupId: groupId,
        });
      }
      batch.delete(enrollmentRef);
    };

    const primaryEnrollmentId = `${groupId}_${studentId}`;
    const primaryEnrollmentSnap = await firestore
      .collection("studentEnrollments")
      .doc(primaryEnrollmentId)
      .get();
    archiveAndDeleteEnrollment(
      primaryEnrollmentId,
      primaryEnrollmentSnap.exists ? primaryEnrollmentSnap.data() ?? null : null,
    );

    const enrollmentsSnap = await firestore
      .collection("studentEnrollments")
      .where("studentId", "==", studentId)
      .where("groupId", "==", groupId)
      .get();
    enrollmentsSnap.docs.forEach((docSnap) => {
      archiveAndDeleteEnrollment(docSnap.id, docSnap.data());
    });

    await batch.commit();
    await syncStudentPlantelAccess(studentId).catch((error) => {
      console.warn("No se pudo sincronizar acceso de plantel del alumno", studentId, error);
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          removed: studentSnap.exists,
        },
      },
      { status: 200 },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
