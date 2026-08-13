import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";
import { buildPhoneLookupValues } from "@/lib/utils/phone";
import {
  AdminTeacherAccessError,
  requireAdminTeacherAccess,
  toAdminTeacherRouteErrorResponse,
} from "@/lib/server/require-admin-teacher-access";
import {
  normalizeTeacherPayrollDeposit,
  normalizeTeacherProfessionalProfile,
} from "@/lib/teachers/profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type UpdateProfileRequest = {
  teacherId?: string;
  currentEmail?: string;
  newEmail?: string;
  newName?: string;
  newPhone?: string;
  teacherProfile?: unknown;
  payrollDeposit?: unknown;
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
  canManageTeacherPayroll: boolean;
};

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeEmail(value: unknown): string {
  return normalizeText(value).toLowerCase();
}

function asUniqueStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean),
    ),
  );
}

function getPlantelIdsFromData(data: Record<string, unknown> | undefined): string[] {
  if (!data) return [];
  const explicit = asUniqueStringArray(data.plantelIds);
  if (explicit.length > 0) return explicit;
  const legacyPlantelId = normalizeText(data.plantelId);
  return legacyPlantelId ? [legacyPlantelId] : [];
}

function hasPlantelIntersection(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) return false;
  const rightSet = new Set(right);
  return left.some((plantelId) => rightSet.has(plantelId));
}

async function teacherHasGroupInPlantels(params: {
  firestore: ReturnType<typeof getAdminFirestore>;
  teacherId: string;
  plantelIds: string[];
}): Promise<boolean> {
  const teacherId = params.teacherId.trim();
  const plantelIds = params.plantelIds.map((plantelId) => plantelId.trim()).filter(Boolean);
  if (!teacherId || plantelIds.length === 0) return false;

  const results = await Promise.all(
    plantelIds.map(async (plantelId) => {
      const snap = await params.firestore
        .collection("groups")
        .where("plantelId", "==", plantelId)
        .get();

      return snap.docs.some((docSnap) => {
        const groupData = docSnap.data() as Record<string, unknown>;
        return (
          normalizeText(groupData.teacherId) === teacherId ||
          asUniqueStringArray(groupData.assistantTeacherIds).includes(teacherId)
        );
      });
    }),
  );

  return results.some(Boolean);
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
      canManageTeacherPayroll: true,
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
    canManageTeacherPayroll:
      role === "adminTeacher" ||
      role === "superAdminTeacher" ||
      role === "coordinadorPlantel" ||
      role === "director",
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
    const hasAccountUpdate =
      body.newEmail !== undefined || body.newName !== undefined || body.newPhone !== undefined;
    const hasTeacherProfileUpdate = body.teacherProfile !== undefined;
    const hasPayrollUpdate = body.payrollDeposit !== undefined;

    if (!requester.canManageAllTeachers && !isSelfUpdate && !hasPayrollUpdate) {
      return NextResponse.json(
        { success: false, error: "Solo puedes editar tu propio CV" },
        { status: 403 },
      );
    }

    const isSelfServiceCvOnly = isSelfUpdate && !requester.canManageAllTeachers;
    if (isSelfServiceCvOnly && hasAccountUpdate) {
      return NextResponse.json(
        { success: false, error: "Solo puedes actualizar tu CV desde autoservicio" },
        { status: 403 },
      );
    }
    if (isSelfServiceCvOnly && hasPayrollUpdate) {
      return NextResponse.json(
        { success: false, error: "No puedes actualizar tus datos de nómina desde autoservicio" },
        { status: 403 },
      );
    }
    if (isSelfServiceCvOnly && !hasTeacherProfileUpdate) {
      return NextResponse.json(
        { success: false, error: "Debes enviar teacherProfile para actualizar tu CV" },
        { status: 400 },
      );
    }

    const isPayrollManagerOnly = !requester.canManageAllTeachers && !isSelfUpdate && hasPayrollUpdate;
    if (isPayrollManagerOnly && !requester.canManageTeacherPayroll) {
      return NextResponse.json(
        { success: false, error: "No tienes permiso para configurar nómina de mentores" },
        { status: 403 },
      );
    }
    if (isPayrollManagerOnly && (hasAccountUpdate || hasTeacherProfileUpdate)) {
      return NextResponse.json(
        {
          success: false,
          error: "Directores y coordinadores solo pueden actualizar datos de nómina",
        },
        { status: 403 },
      );
    }

    const auth = getAdminAuth();
    const firestore = getAdminFirestore();
    const userRecord = await auth.getUser(teacherId);
    const userRef = firestore.collection("users").doc(teacherId);
    const userSnap = await userRef.get();
    const targetUserData = userSnap.data() as Record<string, unknown> | undefined;
    const targetRole =
      asTeacherSelfServiceRole(targetUserData?.role) ??
      asTeacherSelfServiceRole(userRecord.customClaims?.role);

    if (isPayrollManagerOnly && targetRole !== "teacher") {
      return NextResponse.json(
        { success: false, error: "Solo puedes configurar nómina de mentores o profesores" },
        { status: 403 },
      );
    }
    if (
      isPayrollManagerOnly &&
      (requester.role === "coordinadorPlantel" || requester.role === "director")
    ) {
      const requesterSnap = await firestore.collection("users").doc(requester.uid).get();
      const requesterPlantelIds = getPlantelIdsFromData(
        requesterSnap.data() as Record<string, unknown> | undefined,
      );
      const targetPlantelIds = getPlantelIdsFromData(targetUserData);
      const hasDirectPlantelRelation = hasPlantelIntersection(
        requesterPlantelIds,
        targetPlantelIds,
      );
      const hasGroupPlantelRelation =
        hasDirectPlantelRelation ||
        (await teacherHasGroupInPlantels({
          firestore,
          teacherId,
          plantelIds: requesterPlantelIds,
        }));
      if (!hasGroupPlantelRelation) {
        return NextResponse.json(
          { success: false, error: "Solo puedes configurar nómina de profesores de tus planteles" },
          { status: 403 },
        );
      }
    }

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
    const nextPayrollDeposit =
      body.payrollDeposit !== undefined
        ? normalizeTeacherPayrollDeposit(body.payrollDeposit)
        : undefined;

    if (nextPayrollDeposit?.clabe && nextPayrollDeposit.clabe.length !== 18) {
      return NextResponse.json(
        { success: false, error: "La CLABE interbancaria debe tener 18 dígitos" },
        { status: 400 },
      );
    }

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

    if (nextPayrollDeposit !== undefined) {
      firestoreUpdateData.payrollDeposit = nextPayrollDeposit;
    }

    await userRef.set(firestoreUpdateData, { merge: true });

    return NextResponse.json({
      success: true,
      updatedBy: requester.uid,
      updated: {
        email: Boolean(authUpdateData.email),
        name: nextName !== undefined,
        phone: nextPhone !== undefined,
        profile: nextProfile !== undefined,
        payrollDeposit: nextPayrollDeposit !== undefined,
      },
    });
  } catch (error) {
    return toAdminTeacherRouteErrorResponse(error, "Error en teachers/update-profile");
  }
}
