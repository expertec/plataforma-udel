import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";
import { buildPhoneLookupValues } from "@/lib/utils/phone";
import {
  AdminTeacherAccessError,
  requireAdminTeacherAccess,
  toAdminTeacherRouteErrorResponse,
} from "@/lib/server/require-admin-teacher-access";
import { normalizeTeacherProfessionalProfile } from "@/lib/teachers/profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type UpdateProfileRequest = {
  teacherId?: string;
  currentEmail?: string;
  newEmail?: string;
  newName?: string;
  newPhone?: string;
  teacherProfile?: unknown;
};

type TeacherSelfServiceRole =
  | "teacher"
  | "adminTeacher"
  | "superAdminTeacher"
  | "coordinadorPlantel"
  | "director";

type TeacherProfileRequester = {
  uid: string;
  role: TeacherSelfServiceRole;
  canManageAllTeachers: boolean;
};

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeEmail(value: unknown): string {
  return normalizeText(value).toLowerCase();
}

function asTeacherSelfServiceRole(value: unknown): TeacherSelfServiceRole | null {
  return value === "teacher" ||
    value === "adminTeacher" ||
    value === "superAdminTeacher" ||
    value === "director" ||
    value === "coordinadorPlantel"
    ? value
    : null;
}

async function resolveTeacherProfileRequester(
  request: NextRequest,
): Promise<TeacherProfileRequester> {
  try {
    const adminContext = await requireAdminTeacherAccess(request);
    return {
      uid: adminContext.uid,
      role: adminContext.role,
      canManageAllTeachers: true,
    };
  } catch (error) {
    if (!(error instanceof AdminTeacherAccessError)) {
      throw error;
    }
  }

  const authorization = request.headers.get("authorization")?.trim() ?? "";
  if (!authorization.toLowerCase().startsWith("bearer ")) {
    throw new AdminTeacherAccessError(401, "Authorization Bearer token requerido");
  }

  const idToken = authorization.slice(7).trim();
  if (!idToken) {
    throw new AdminTeacherAccessError(401, "Authorization Bearer token requerido");
  }

  let decodedToken: Awaited<ReturnType<ReturnType<typeof getAdminAuth>["verifyIdToken"]>>;
  try {
    decodedToken = await getAdminAuth().verifyIdToken(idToken);
  } catch {
    throw new AdminTeacherAccessError(401, "Token inválido o expirado");
  }

  const firestore = getAdminFirestore();
  const userSnap = await firestore.collection("users").doc(decodedToken.uid).get();
  const role =
    asTeacherSelfServiceRole(userSnap.data()?.role) ??
    asTeacherSelfServiceRole(decodedToken.role);

  if (!role) {
    throw new AdminTeacherAccessError(403, "Acceso restringido a docentes");
  }

  return {
    uid: decodedToken.uid,
    role,
    canManageAllTeachers: role === "adminTeacher" || role === "superAdminTeacher",
  };
}

export async function POST(request: NextRequest) {
  try {
    const requester = await resolveTeacherProfileRequester(request);
    const body = (await request.json().catch(() => ({}))) as UpdateProfileRequest;

    const teacherId = normalizeText(body.teacherId);
    if (!teacherId) {
      return NextResponse.json(
        { success: false, error: "teacherId es requerido" },
        { status: 400 },
      );
    }

    const isSelfUpdate = requester.uid === teacherId;
    if (!requester.canManageAllTeachers && !isSelfUpdate) {
      return NextResponse.json(
        { success: false, error: "Solo puedes editar tu propio CV" },
        { status: 403 },
      );
    }

    const isSelfServiceCvOnly = isSelfUpdate && !requester.canManageAllTeachers;
    if (
      isSelfServiceCvOnly &&
      (body.newEmail !== undefined || body.newName !== undefined || body.newPhone !== undefined)
    ) {
      return NextResponse.json(
        { success: false, error: "Solo puedes actualizar tu CV desde autoservicio" },
        { status: 403 },
      );
    }
    if (isSelfServiceCvOnly && body.teacherProfile === undefined) {
      return NextResponse.json(
        { success: false, error: "Debes enviar teacherProfile para actualizar tu CV" },
        { status: 400 },
      );
    }

    const auth = getAdminAuth();
    const firestore = getAdminFirestore();
    const userRecord = await auth.getUser(teacherId);

    const currentEmail = normalizeEmail(body.currentEmail);
    const userRecordEmail = normalizeEmail(userRecord.email);
    if (currentEmail && userRecordEmail && currentEmail !== userRecordEmail) {
      return NextResponse.json(
        { success: false, error: "El email actual no coincide con el usuario indicado" },
        { status: 400 },
      );
    }

    const requestedEmail = normalizeEmail(body.newEmail);
    const nextName = body.newName !== undefined ? normalizeText(body.newName) : undefined;
    const nextPhone = body.newPhone !== undefined ? normalizeText(body.newPhone) : undefined;
    const nextProfile =
      body.teacherProfile !== undefined
        ? normalizeTeacherProfessionalProfile(body.teacherProfile)
        : undefined;

    const authUpdateData: {
      email?: string;
      displayName?: string;
    } = {};

    if (requestedEmail && requestedEmail !== userRecordEmail) {
      try {
        const existingUser = await auth.getUserByEmail(requestedEmail);
        if (existingUser.uid !== teacherId) {
          return NextResponse.json(
            { success: false, error: "El email ya está en uso por otro usuario" },
            { status: 400 },
          );
        }
      } catch (error) {
        const code = (error as { code?: string } | undefined)?.code;
        if (code !== "auth/user-not-found") {
          throw error;
        }
      }
      authUpdateData.email = requestedEmail;
    }

    if (nextName !== undefined && nextName !== normalizeText(userRecord.displayName)) {
      authUpdateData.displayName = nextName;
    }

    if (Object.keys(authUpdateData).length > 0) {
      await auth.updateUser(teacherId, authUpdateData);
    }

    const firestoreUpdateData: Record<string, unknown> = {
      updatedAt: new Date(),
      updatedBy: requester.uid,
    };

    if (authUpdateData.email) {
      firestoreUpdateData.email = authUpdateData.email;
    }

    if (nextName !== undefined) {
      firestoreUpdateData.name = nextName;
      firestoreUpdateData.displayName = nextName;
    }

    if (nextPhone !== undefined) {
      firestoreUpdateData.phone = nextPhone || null;
      firestoreUpdateData.lookupPhones = buildPhoneLookupValues([nextPhone]);
    }

    if (nextProfile !== undefined) {
      firestoreUpdateData.teacherProfile = nextProfile;
    }

    await firestore.collection("users").doc(teacherId).set(firestoreUpdateData, { merge: true });

    return NextResponse.json({
      success: true,
      updatedBy: requester.uid,
      updated: {
        email: Boolean(authUpdateData.email),
        name: nextName !== undefined,
        phone: nextPhone !== undefined,
        profile: nextProfile !== undefined,
      },
    });
  } catch (error) {
    return toAdminTeacherRouteErrorResponse(error, "Error en teachers/update-profile");
  }
}
