import type { UserRecord } from "firebase-admin/auth";
import * as admin from "firebase-admin";
import { getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";
import {
  ACTIVE_STUDENT_STATUS,
  ARCHIVED_STUDENT_STATUS,
  isStudentStatusActive,
  isStudentStatusBlocked,
} from "@/lib/students/status";
import {
  extractPhoneLookupValues,
  normalizePhoneToLocal10,
} from "@/lib/utils/phone";

type StudentArchiveParams = {
  uid?: string;
  email?: string;
  phone?: string;
  archivedBy: string;
  source: "admin-panel" | "finance-webhook";
  reason?: string | null;
  reasonType?: string | null;
  allowedPlantelIds?: string[];
};

type StudentReactivateParams = {
  uid: string;
  reactivatedBy: string;
  allowedPlantelIds?: string[];
};

export class StudentArchiveError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type ResolvedStudentIdentity = {
  uid: string;
  email: string | null;
  displayName: string | null;
  userRecord: UserRecord;
  role: string | null;
  plantelIds: string[];
  plantelNames: string[];
  archivedPlantelIds: string[];
  archivedPlantelNames: string[];
};

export type StudentArchiveResult = {
  uid: string;
  email: string | null;
  displayName: string | null;
  role: string | null;
  archivedEnrollments: number;
  archivedGroupMemberships: number;
  affectedGroups: number;
};

export type StudentReactivateResult = {
  uid: string;
  email: string | null;
  displayName: string | null;
  role: string | null;
  reactivatedEnrollments: number;
  reactivatedGroupMemberships: number;
  affectedGroups: number;
};

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

function getPlantelIds(data: Record<string, unknown>): string[] {
  const plantelIds = asUniqueStringArray(data.plantelIds);
  if (plantelIds.length > 0) return plantelIds;
  const legacyPlantelId = asTrimmedString(data.plantelId);
  return legacyPlantelId ? [legacyPlantelId] : [];
}

function getPlantelNames(data: Record<string, unknown>): string[] {
  const plantelNames = asUniqueStringArray(data.plantelNames);
  if (plantelNames.length > 0) return plantelNames;
  const legacyPlantelName = asTrimmedString(data.plantelName);
  return legacyPlantelName ? [legacyPlantelName] : [];
}

function asDropoutReasonType(value: unknown): string | null {
  const normalized = asTrimmedString(value).toLowerCase();
  if (normalized === "voluntaria" || normalized === "baja voluntaria") {
    return "Baja Voluntaria";
  }
  if (normalized === "involuntaria" || normalized === "baja involuntaria") {
    return "Baja involuntaria";
  }
  return null;
}

function isPotentialStudentRole(role: string): boolean {
  return !role || role === "student";
}

async function resolveStudentUidByPhone(params: {
  phone: string;
  uid?: string;
  email?: string;
}): Promise<string> {
  const firestore = getAdminFirestore();
  const normalizedPhone = normalizePhoneToLocal10(params.phone);
  if (normalizedPhone.length !== 10) {
    throw new StudentArchiveError(400, "El teléfono del alumno es inválido");
  }

  const collectMatches = async (): Promise<Array<{ uid: string; data: Record<string, unknown> }>> => {
    const indexedSnap = await firestore
      .collection("users")
      .where("lookupPhones", "array-contains", normalizedPhone)
      .limit(5)
      .get();
    const indexedMatches = indexedSnap.docs
      .map((docSnap) => ({
        uid: docSnap.id,
        data: docSnap.data() as Record<string, unknown>,
      }))
      .filter(({ data }) => extractPhoneLookupValues(data).includes(normalizedPhone));
    if (indexedMatches.length > 0) {
      return indexedMatches;
    }

    const studentSnap = await firestore.collection("users").where("role", "==", "student").get();
    const studentMatches = studentSnap.docs
      .map((docSnap) => ({
        uid: docSnap.id,
        data: docSnap.data() as Record<string, unknown>,
      }))
      .filter(({ data }) => extractPhoneLookupValues(data).includes(normalizedPhone));
    if (studentMatches.length > 0) {
      return studentMatches;
    }

    const allUsersSnap = await firestore.collection("users").get();
    return allUsersSnap.docs
      .map((docSnap) => ({
        uid: docSnap.id,
        data: docSnap.data() as Record<string, unknown>,
      }))
      .filter(({ data }) => extractPhoneLookupValues(data).includes(normalizedPhone));
  };

  let matches = (await collectMatches()).filter(({ data }) =>
    isPotentialStudentRole(asTrimmedString(data.role)),
  );

  const normalizedUid = asTrimmedString(params.uid);
  if (normalizedUid) {
    matches = matches.filter((match) => match.uid === normalizedUid);
  }

  const normalizedEmail = asTrimmedString(params.email).toLowerCase();
  if (normalizedEmail) {
    const emailMatches = matches.filter(
      ({ data }) => asTrimmedString(data.email).toLowerCase() === normalizedEmail,
    );
    if (emailMatches.length > 0) {
      matches = emailMatches;
    }
  }

  if (matches.length === 0) {
    if (normalizedUid) {
      throw new StudentArchiveError(404, "El teléfono no coincide con el UID proporcionado");
    }
    if (normalizedEmail) {
      throw new StudentArchiveError(404, "El teléfono no coincide con el email proporcionado");
    }
    throw new StudentArchiveError(404, "No existe un alumno con ese teléfono");
  }

  if (matches.length > 1) {
    throw new StudentArchiveError(
      409,
      "Más de un alumno coincide con ese teléfono; envía también studentId o email",
    );
  }

  return matches[0].uid;
}

async function resolveStudentIdentity(params: {
  uid?: string;
  email?: string;
  phone?: string;
}): Promise<ResolvedStudentIdentity> {
  const auth = getAdminAuth();
  const firestore = getAdminFirestore();
  const normalizedUid = asTrimmedString(params.uid);
  const normalizedEmail = asTrimmedString(params.email).toLowerCase();
  const normalizedPhone = asTrimmedString(params.phone);

  let userRecord: UserRecord;
  if (normalizedPhone) {
    const resolvedUid = await resolveStudentUidByPhone({
      phone: normalizedPhone,
      uid: normalizedUid || undefined,
      email: normalizedEmail || undefined,
    });
    try {
      userRecord = await auth.getUser(resolvedUid);
    } catch (error: unknown) {
      const code = (error as { code?: string })?.code ?? "";
      if (code === "auth/user-not-found") {
        throw new StudentArchiveError(404, "No existe un alumno con ese teléfono");
      }
      throw error;
    }
    if (normalizedUid && userRecord.uid !== normalizedUid) {
      throw new StudentArchiveError(400, "El teléfono no coincide con el UID proporcionado");
    }
    if (normalizedEmail && userRecord.email?.trim().toLowerCase() !== normalizedEmail) {
      throw new StudentArchiveError(400, "El teléfono no coincide con el email proporcionado");
    }
  } else if (normalizedUid) {
    try {
      userRecord = await auth.getUser(normalizedUid);
    } catch (error: unknown) {
      const code = (error as { code?: string })?.code ?? "";
      if (code === "auth/user-not-found") {
        throw new StudentArchiveError(404, "No existe un alumno con ese UID");
      }
      throw error;
    }
    if (normalizedEmail && userRecord.email?.trim().toLowerCase() !== normalizedEmail) {
      throw new StudentArchiveError(400, "El email no coincide con el UID proporcionado");
    }
  } else if (normalizedEmail) {
    try {
      userRecord = await auth.getUserByEmail(normalizedEmail);
    } catch (error: unknown) {
      const code = (error as { code?: string })?.code ?? "";
      if (code === "auth/user-not-found") {
        throw new StudentArchiveError(404, "No existe un alumno con ese email");
      }
      throw error;
    }
  } else {
    throw new StudentArchiveError(400, "uid, email o teléfono son requeridos para archivar al alumno");
  }

  const userSnap = await firestore.collection("users").doc(userRecord.uid).get();
  const userData = (userSnap.data() ?? {}) as Record<string, unknown>;
  const roleFromDoc = asTrimmedString(userSnap.data()?.role) || null;
  const roleFromClaims =
    typeof userRecord.customClaims?.role === "string" && userRecord.customClaims.role.trim()
      ? userRecord.customClaims.role.trim()
      : null;
  const resolvedRole = roleFromDoc ?? roleFromClaims;

  if (normalizedPhone) {
    const matchedPhones = extractPhoneLookupValues(userData);
    if (!matchedPhones.includes(normalizePhoneToLocal10(normalizedPhone))) {
      throw new StudentArchiveError(400, "El teléfono no coincide con el alumno encontrado");
    }
  }

  if (resolvedRole && resolvedRole !== "student") {
    throw new StudentArchiveError(409, `El usuario ${userRecord.uid} no tiene rol alumno`);
  }

  return {
    uid: userRecord.uid,
    email: userRecord.email ?? null,
    displayName: userRecord.displayName ?? null,
    userRecord,
    role: resolvedRole,
    plantelIds: getPlantelIds(userData),
    plantelNames: getPlantelNames(userData),
    archivedPlantelIds: asUniqueStringArray(userData.archivedPlantelIds),
    archivedPlantelNames: asUniqueStringArray(userData.archivedPlantelNames),
  };
}

export async function archiveStudentAccount(
  params: StudentArchiveParams,
): Promise<StudentArchiveResult> {
  const firestore = getAdminFirestore();
  const auth = getAdminAuth();
  const resolved = await resolveStudentIdentity(params);
  const now = new Date();
  const reason = asTrimmedString(params.reason) || null;
  const reasonType = asDropoutReasonType(params.reasonType);
  const allowedPlantelIds = asUniqueStringArray(params.allowedPlantelIds);

  if (params.allowedPlantelIds && allowedPlantelIds.length === 0) {
    throw new StudentArchiveError(403, "No tienes un plantel asignado para dar de baja alumnos");
  }

  if (
    allowedPlantelIds.length > 0 &&
    !resolved.plantelIds.some((plantelId) => allowedPlantelIds.includes(plantelId))
  ) {
    throw new StudentArchiveError(403, "No tienes permisos para dar de baja a este alumno");
  }

  const userRef = firestore.collection("users").doc(resolved.uid);
  const [enrollmentsSnap, membershipsSnap] = await Promise.all([
    firestore.collection("studentEnrollments").where("studentId", "==", resolved.uid).get(),
    firestore.collectionGroup("students").where("studentId", "==", resolved.uid).get(),
  ]);

  const affectedGroupIds = new Set<string>();

  enrollmentsSnap.docs.forEach((docSnap) => {
    const data = docSnap.data() as Record<string, unknown>;
    const groupId = asTrimmedString(data.groupId);
    if (groupId && isStudentStatusActive(data.status)) {
      affectedGroupIds.add(groupId);
    }
  });

  membershipsSnap.docs.forEach((docSnap) => {
    const data = docSnap.data() as Record<string, unknown>;
    const groupId = asTrimmedString(docSnap.ref.parent.parent?.id);
    if (groupId && isStudentStatusActive(data.status)) {
      affectedGroupIds.add(groupId);
    }
  });

  const groupSnaps = await Promise.all(
    Array.from(affectedGroupIds).map((groupId) => firestore.collection("groups").doc(groupId).get()),
  );

  const batch = firestore.batch();
  batch.set(
    userRef,
    {
      status: ARCHIVED_STUDENT_STATUS,
      archivedAt: now,
      archivedBy: params.archivedBy,
      archivedSource: params.source,
      archivedReasonType: reasonType,
      archivedReason: reason,
      archivedPlantelIds: resolved.plantelIds,
      archivedPlantelNames: resolved.plantelNames,
      updatedAt: now,
      updatedBy: params.archivedBy,
      plantelIds: [],
      plantelNames: [],
    },
    { merge: true },
  );

  enrollmentsSnap.docs.forEach((docSnap) => {
    batch.set(
      docSnap.ref,
      {
        status: ARCHIVED_STUDENT_STATUS,
        archivedAt: now,
        archivedBy: params.archivedBy,
        archivedSource: params.source,
        archivedReasonType: reasonType,
        archivedReason: reason,
        updatedAt: now,
        updatedBy: params.archivedBy,
      },
      { merge: true },
    );
  });

  membershipsSnap.docs.forEach((docSnap) => {
    batch.set(
      docSnap.ref,
      {
        status: ARCHIVED_STUDENT_STATUS,
        archivedAt: now,
        archivedBy: params.archivedBy,
        archivedSource: params.source,
        archivedReasonType: reasonType,
        archivedReason: reason,
        updatedAt: now,
        updatedBy: params.archivedBy,
      },
      { merge: true },
    );
  });

  groupSnaps.forEach((groupSnap) => {
    if (!groupSnap.exists) return;
    const data = groupSnap.data() as Record<string, unknown>;
    const currentCount =
      typeof data.studentsCount === "number" && Number.isFinite(data.studentsCount)
        ? data.studentsCount
        : 0;
    batch.set(
      groupSnap.ref,
      {
        studentsCount: Math.max(currentCount - 1, 0),
        updatedAt: now,
      },
      { merge: true },
    );
  });

  await batch.commit();
  await auth.updateUser(resolved.uid, { disabled: true });
  await auth.revokeRefreshTokens(resolved.uid);

  return {
    uid: resolved.uid,
    email: resolved.email,
    displayName: resolved.displayName,
    role: resolved.role,
    archivedEnrollments: enrollmentsSnap.size,
    archivedGroupMemberships: membershipsSnap.size,
    affectedGroups: affectedGroupIds.size,
  };
}

export async function reactivateStudentAccount(
  params: StudentReactivateParams,
): Promise<StudentReactivateResult> {
  const firestore = getAdminFirestore();
  const auth = getAdminAuth();
  const resolved = await resolveStudentIdentity({ uid: params.uid });
  const now = new Date();
  const allowedPlantelIds = asUniqueStringArray(params.allowedPlantelIds);
  const restoredPlantelIds =
    resolved.archivedPlantelIds.length > 0 ? resolved.archivedPlantelIds : resolved.plantelIds;
  const restoredPlantelNames =
    resolved.archivedPlantelNames.length > 0 ? resolved.archivedPlantelNames : resolved.plantelNames;

  if (params.allowedPlantelIds && allowedPlantelIds.length === 0) {
    throw new StudentArchiveError(403, "No tienes un plantel asignado para reactivar alumnos");
  }

  if (
    allowedPlantelIds.length > 0 &&
    !restoredPlantelIds.some((plantelId) => allowedPlantelIds.includes(plantelId))
  ) {
    throw new StudentArchiveError(403, "No tienes permisos para reactivar a este alumno");
  }

  const userRef = firestore.collection("users").doc(resolved.uid);
  const [enrollmentsSnap, membershipsSnap] = await Promise.all([
    firestore.collection("studentEnrollments").where("studentId", "==", resolved.uid).get(),
    firestore.collectionGroup("students").where("studentId", "==", resolved.uid).get(),
  ]);

  const affectedGroupIds = new Set<string>();
  const archivedEnrollments = enrollmentsSnap.docs.filter((docSnap) => {
    const data = docSnap.data() as Record<string, unknown>;
    const groupId = asTrimmedString(data.groupId);
    if (groupId && isStudentStatusBlocked(data.status)) {
      affectedGroupIds.add(groupId);
      return true;
    }
    return false;
  });
  const archivedMemberships = membershipsSnap.docs.filter((docSnap) => {
    const data = docSnap.data() as Record<string, unknown>;
    const groupId = asTrimmedString(docSnap.ref.parent.parent?.id);
    if (groupId && isStudentStatusBlocked(data.status)) {
      affectedGroupIds.add(groupId);
      return true;
    }
    return false;
  });

  const batch = firestore.batch();
  batch.set(
    userRef,
    {
      status: ACTIVE_STUDENT_STATUS,
      reactivatedAt: now,
      reactivatedBy: params.reactivatedBy,
      updatedAt: now,
      updatedBy: params.reactivatedBy,
      plantelIds: restoredPlantelIds,
      plantelNames: restoredPlantelNames,
    },
    { merge: true },
  );

  archivedEnrollments.forEach((docSnap) => {
    batch.set(
      docSnap.ref,
      {
        status: ACTIVE_STUDENT_STATUS,
        reactivatedAt: now,
        reactivatedBy: params.reactivatedBy,
        updatedAt: now,
        updatedBy: params.reactivatedBy,
      },
      { merge: true },
    );
  });

  archivedMemberships.forEach((docSnap) => {
    batch.set(
      docSnap.ref,
      {
        status: ACTIVE_STUDENT_STATUS,
        reactivatedAt: now,
        reactivatedBy: params.reactivatedBy,
        updatedAt: now,
        updatedBy: params.reactivatedBy,
      },
      { merge: true },
    );
  });

  affectedGroupIds.forEach((groupId) => {
    batch.set(
      firestore.collection("groups").doc(groupId),
      {
        studentsCount: admin.firestore.FieldValue.increment(1),
        updatedAt: now,
      },
      { merge: true },
    );
  });

  await batch.commit();
  await auth.updateUser(resolved.uid, { disabled: false });

  return {
    uid: resolved.uid,
    email: resolved.email,
    displayName: resolved.displayName,
    role: resolved.role,
    reactivatedEnrollments: archivedEnrollments.length,
    reactivatedGroupMemberships: archivedMemberships.length,
    affectedGroups: affectedGroupIds.size,
  };
}
