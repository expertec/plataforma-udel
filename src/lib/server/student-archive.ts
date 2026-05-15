import type { UserRecord } from "firebase-admin/auth";
import { getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";
import {
  ARCHIVED_STUDENT_STATUS,
  isStudentStatusActive,
} from "@/lib/students/status";

type StudentArchiveParams = {
  uid?: string;
  email?: string;
  archivedBy: string;
  source: "admin-panel" | "finance-webhook";
  reason?: string | null;
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

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function resolveStudentIdentity(params: {
  uid?: string;
  email?: string;
}): Promise<ResolvedStudentIdentity> {
  const auth = getAdminAuth();
  const firestore = getAdminFirestore();
  const normalizedUid = asTrimmedString(params.uid);
  const normalizedEmail = asTrimmedString(params.email).toLowerCase();

  let userRecord: UserRecord;
  if (normalizedUid) {
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
    throw new StudentArchiveError(400, "uid o email son requeridos para archivar al alumno");
  }

  const userSnap = await firestore.collection("users").doc(userRecord.uid).get();
  const roleFromDoc = asTrimmedString(userSnap.data()?.role) || null;
  const roleFromClaims =
    typeof userRecord.customClaims?.role === "string" && userRecord.customClaims.role.trim()
      ? userRecord.customClaims.role.trim()
      : null;
  const resolvedRole = roleFromDoc ?? roleFromClaims;

  if (resolvedRole && resolvedRole !== "student") {
    throw new StudentArchiveError(409, `El usuario ${userRecord.uid} no tiene rol alumno`);
  }

  return {
    uid: userRecord.uid,
    email: userRecord.email ?? null,
    displayName: userRecord.displayName ?? null,
    userRecord,
    role: resolvedRole,
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
      archivedReason: reason,
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
