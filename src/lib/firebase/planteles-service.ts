import {
  addDoc,
  collection,
  deleteField,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import type { DocumentData, DocumentReference } from "firebase/firestore";
import { db } from "@/lib/firebase/firestore";

export type Plantel = {
  id: string;
  name: string;
  normalizedName: string;
  status: "active" | "archived";
  createdAt?: Date | null;
  updatedAt?: Date | null;
};

export type PlantelAssignment = {
  plantelId: string;
  plantelName: string;
};

const MAX_BATCH_WRITES = 450;

export function normalizePlantelName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function toPlantel(id: string, data: Record<string, unknown>): Plantel {
  const name =
    (typeof data.name === "string" && data.name.trim()) ||
    (typeof data.nombre === "string" && data.nombre.trim()) ||
    (typeof data.plantelName === "string" && data.plantelName.trim()) ||
    "Plantel";
  const normalizedName =
    (typeof data.normalizedName === "string" && data.normalizedName.trim()) ||
    normalizePlantelName(name);
  return {
    id,
    name,
    normalizedName,
    status: data.status === "archived" ? "archived" : "active",
    createdAt:
      data.createdAt &&
      typeof data.createdAt === "object" &&
      "toDate" in data.createdAt &&
      typeof data.createdAt.toDate === "function"
        ? data.createdAt.toDate()
        : null,
    updatedAt:
      data.updatedAt &&
      typeof data.updatedAt === "object" &&
      "toDate" in data.updatedAt &&
      typeof data.updatedAt.toDate === "function"
        ? data.updatedAt.toDate()
        : null,
  };
}

type QueuedUpdate = {
  ref: DocumentReference<DocumentData>;
  data: Record<string, unknown>;
};

function queueUpdate(
  updates: Map<string, QueuedUpdate>,
  ref: DocumentReference<DocumentData>,
  data: Record<string, unknown>,
) {
  const existing = updates.get(ref.path);
  if (existing) {
    Object.assign(existing.data, data);
    return;
  }
  updates.set(ref.path, { ref, data });
}

async function commitQueuedUpdates(updates: Iterable<QueuedUpdate>): Promise<void> {
  let batch = writeBatch(db);
  let count = 0;

  for (const update of updates) {
    batch.update(update.ref, update.data);
    count += 1;

    if (count >= MAX_BATCH_WRITES) {
      await batch.commit();
      batch = writeBatch(db);
      count = 0;
    }
  }

  if (count > 0) {
    await batch.commit();
  }
}

function replacePlantelNameArray(value: unknown, oldName: string, newName: string): string[] {
  const oldNormalizedName = normalizePlantelName(oldName);
  const newNormalizedName = normalizePlantelName(newName);
  const currentNames = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const nextNames = currentNames.filter((item) => {
    const normalizedItem = normalizePlantelName(item);
    return normalizedItem !== oldNormalizedName && normalizedItem !== newNormalizedName;
  });
  return [...nextNames, newName];
}

function toUniqueStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      ),
    ),
  );
}

function dedupePlantelAssignments(assignments: PlantelAssignment[]): PlantelAssignment[] {
  const map = new Map<string, PlantelAssignment>();
  assignments.forEach((assignment) => {
    const plantelId = assignment.plantelId.trim();
    if (!plantelId) return;
    const existing = map.get(plantelId);
    const plantelName = assignment.plantelName.trim();
    if (!existing) {
      map.set(plantelId, { plantelId, plantelName });
      return;
    }
    if (!existing.plantelName && plantelName) {
      map.set(plantelId, { plantelId, plantelName });
    }
  });
  return Array.from(map.values());
}

export function getPlantelAssignmentsFromData(data: Record<string, unknown>): PlantelAssignment[] {
  const plantelIds = toUniqueStringArray(data.plantelIds);
  const plantelNames = Array.isArray(data.plantelNames)
    ? data.plantelNames.filter((item): item is string => typeof item === "string")
    : [];

  if (plantelIds.length > 0) {
    return dedupePlantelAssignments(
      plantelIds.map((plantelId, index) => ({
        plantelId,
        plantelName: plantelNames[index]?.trim() ?? "",
      })),
    );
  }

  const legacyPlantelId = typeof data.plantelId === "string" ? data.plantelId.trim() : "";
  if (!legacyPlantelId) return [];
  return [
    {
      plantelId: legacyPlantelId,
      plantelName: typeof data.plantelName === "string" ? data.plantelName.trim() : "",
    },
  ];
}

function replacePlantelAssignmentName(
  assignments: PlantelAssignment[],
  plantelId: string,
  plantelName: string,
): PlantelAssignment[] {
  return dedupePlantelAssignments(
    assignments.map((assignment) =>
      assignment.plantelId === plantelId
        ? { ...assignment, plantelName }
        : assignment,
    ),
  );
}

function removePlantelAssignment(
  assignments: PlantelAssignment[],
  plantelId: string,
): PlantelAssignment[] {
  return dedupePlantelAssignments(
    assignments.filter((assignment) => assignment.plantelId !== plantelId),
  );
}

function toPlantelAssignmentFields(assignments: PlantelAssignment[]): Record<string, unknown> {
  const nextAssignments = dedupePlantelAssignments(assignments);
  const primaryAssignment = nextAssignments[0] ?? null;
  return {
    plantelIds: nextAssignments.map((assignment) => assignment.plantelId),
    plantelNames: nextAssignments.map((assignment) => assignment.plantelName),
    plantelId: primaryAssignment?.plantelId ?? deleteField(),
    plantelName: primaryAssignment?.plantelName ?? deleteField(),
  };
}

function removePlantelNameFromArray(value: unknown, plantelName: string): string[] {
  const normalizedPlantelName = normalizePlantelName(plantelName);
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string =>
      typeof item === "string" &&
      item.trim().length > 0 &&
      normalizePlantelName(item) !== normalizedPlantelName,
  );
}

function removePlantelIdFromArray(value: unknown, plantelId: string): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item !== plantelId);
}

export async function getPlanteles(): Promise<Plantel[]> {
  const snap = await getDocs(query(collection(db, "planteles"), orderBy("name", "asc")));
  return snap.docs
    .map((docSnap) => toPlantel(docSnap.id, docSnap.data()))
    .filter((plantel) => plantel.status === "active")
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
}

export async function getPlantel(plantelId: string): Promise<Plantel | null> {
  if (!plantelId) return null;
  const snap = await getDoc(doc(db, "planteles", plantelId));
  if (!snap.exists()) return null;
  return toPlantel(snap.id, snap.data());
}

export async function createPlantel(name: string): Promise<Plantel> {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("El nombre del plantel es requerido");
  }

  const normalizedName = normalizePlantelName(trimmed);
  const existingSnap = await getDocs(
    query(collection(db, "planteles"), where("normalizedName", "==", normalizedName), limit(1)),
  );
  if (!existingSnap.empty) {
    const existing = existingSnap.docs[0];
    await updateDoc(existing.ref, {
      name: trimmed,
      normalizedName,
      status: "active",
      updatedAt: serverTimestamp(),
    });
    return {
      ...toPlantel(existing.id, existing.data()),
      name: trimmed,
      normalizedName,
      status: "active",
      updatedAt: null,
    };
  }

  const docRef = await addDoc(collection(db, "planteles"), {
    name: trimmed,
    normalizedName,
    status: "active",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  return {
    id: docRef.id,
    name: trimmed,
    normalizedName,
    status: "active",
    createdAt: null,
    updatedAt: null,
  };
}

export async function updatePlantel(plantelId: string, name: string): Promise<Plantel> {
  const normalizedPlantelId = plantelId.trim();
  const trimmed = name.trim();
  if (!normalizedPlantelId || !trimmed) {
    throw new Error("El plantel y el nombre son requeridos");
  }

  const plantelRef = doc(db, "planteles", normalizedPlantelId);
  const plantelSnap = await getDoc(plantelRef);
  if (!plantelSnap.exists()) {
    throw new Error("Plantel no encontrado");
  }

  const currentPlantel = toPlantel(plantelSnap.id, plantelSnap.data());
  const normalizedName = normalizePlantelName(trimmed);
  const duplicateSnap = await getDocs(
    query(collection(db, "planteles"), where("normalizedName", "==", normalizedName), limit(5)),
  );
  const duplicatePlantel = duplicateSnap.docs.find((docSnap) => docSnap.id !== normalizedPlantelId);
  if (duplicatePlantel) {
    throw new Error("Ya existe otro plantel con ese nombre");
  }

  const [legacyCoordinatorUsersSnap, usersWithPlantelArraySnap, groupsSnap, enrollmentsSnap] = await Promise.all([
    getDocs(query(collection(db, "users"), where("plantelId", "==", normalizedPlantelId))),
    getDocs(query(collection(db, "users"), where("plantelIds", "array-contains", normalizedPlantelId))),
    getDocs(query(collection(db, "groups"), where("plantelId", "==", normalizedPlantelId))),
    getDocs(query(collection(db, "studentEnrollments"), where("plantelId", "==", normalizedPlantelId))),
  ]);
  const groupStudentSnaps = await Promise.all(
    groupsSnap.docs.map((groupDoc) => getDocs(collection(db, "groups", groupDoc.id, "students"))),
  );

  const updates = new Map<string, QueuedUpdate>();
  queueUpdate(updates, plantelRef, {
    name: trimmed,
    normalizedName,
    status: "active",
    updatedAt: serverTimestamp(),
  });

  const coordinatorUsersByPath = new Map<string, typeof legacyCoordinatorUsersSnap.docs[number]>();
  const studentUsersByPath = new Map<string, typeof usersWithPlantelArraySnap.docs[number]>();
  [...legacyCoordinatorUsersSnap.docs, ...usersWithPlantelArraySnap.docs].forEach((userDoc) => {
    const data = userDoc.data();
    if (data.role === "student") {
      studentUsersByPath.set(userDoc.ref.path, userDoc);
      return;
    }
    coordinatorUsersByPath.set(userDoc.ref.path, userDoc);
  });

  coordinatorUsersByPath.forEach((userDoc) => {
    const assignments = getPlantelAssignmentsFromData(userDoc.data());
    queueUpdate(updates, userDoc.ref, {
      ...toPlantelAssignmentFields(
        replacePlantelAssignmentName(assignments, normalizedPlantelId, trimmed),
      ),
      updatedAt: serverTimestamp(),
    });
  });
  studentUsersByPath.forEach((userDoc) => {
    queueUpdate(updates, userDoc.ref, {
      plantelNames: replacePlantelNameArray(userDoc.data().plantelNames, currentPlantel.name, trimmed),
      updatedAt: serverTimestamp(),
    });
  });
  groupsSnap.docs.forEach((groupDoc) => {
    queueUpdate(updates, groupDoc.ref, {
      plantelName: trimmed,
      updatedAt: serverTimestamp(),
    });
  });
  groupStudentSnaps.forEach((studentsSnap) => {
    studentsSnap.docs.forEach((studentDoc) => {
      queueUpdate(updates, studentDoc.ref, {
        plantelName: trimmed,
        updatedAt: serverTimestamp(),
      });
    });
  });
  enrollmentsSnap.docs.forEach((enrollmentDoc) => {
    queueUpdate(updates, enrollmentDoc.ref, {
      plantelName: trimmed,
      updatedAt: serverTimestamp(),
    });
  });

  await commitQueuedUpdates(updates.values());
  return {
    ...currentPlantel,
    name: trimmed,
    normalizedName,
    status: "active",
    updatedAt: null,
  };
}

export async function deletePlantel(plantelId: string): Promise<void> {
  const normalizedPlantelId = plantelId.trim();
  if (!normalizedPlantelId) {
    throw new Error("El plantel es requerido");
  }

  const plantelRef = doc(db, "planteles", normalizedPlantelId);
  const plantelSnap = await getDoc(plantelRef);
  if (!plantelSnap.exists()) {
    throw new Error("Plantel no encontrado");
  }

  const currentPlantel = toPlantel(plantelSnap.id, plantelSnap.data());
  const [legacyCoordinatorUsersSnap, usersWithPlantelArraySnap, groupsSnap, enrollmentsSnap] = await Promise.all([
    getDocs(query(collection(db, "users"), where("plantelId", "==", normalizedPlantelId))),
    getDocs(query(collection(db, "users"), where("plantelIds", "array-contains", normalizedPlantelId))),
    getDocs(query(collection(db, "groups"), where("plantelId", "==", normalizedPlantelId))),
    getDocs(query(collection(db, "studentEnrollments"), where("plantelId", "==", normalizedPlantelId))),
  ]);
  const groupStudentSnaps = await Promise.all(
    groupsSnap.docs.map((groupDoc) => getDocs(collection(db, "groups", groupDoc.id, "students"))),
  );

  const updates = new Map<string, QueuedUpdate>();
  queueUpdate(updates, plantelRef, {
    status: "archived",
    updatedAt: serverTimestamp(),
  });

  const coordinatorUsersByPath = new Map<string, typeof legacyCoordinatorUsersSnap.docs[number]>();
  const studentUsersByPath = new Map<string, typeof usersWithPlantelArraySnap.docs[number]>();
  [...legacyCoordinatorUsersSnap.docs, ...usersWithPlantelArraySnap.docs].forEach((userDoc) => {
    const data = userDoc.data();
    if (data.role === "student") {
      studentUsersByPath.set(userDoc.ref.path, userDoc);
      return;
    }
    coordinatorUsersByPath.set(userDoc.ref.path, userDoc);
  });

  coordinatorUsersByPath.forEach((userDoc) => {
    const assignments = getPlantelAssignmentsFromData(userDoc.data());
    queueUpdate(updates, userDoc.ref, {
      ...toPlantelAssignmentFields(removePlantelAssignment(assignments, normalizedPlantelId)),
      updatedAt: serverTimestamp(),
    });
  });
  studentUsersByPath.forEach((userDoc) => {
    const data = userDoc.data();
    queueUpdate(updates, userDoc.ref, {
      plantelIds: removePlantelIdFromArray(data.plantelIds, normalizedPlantelId),
      plantelNames: removePlantelNameFromArray(data.plantelNames, currentPlantel.name),
      plantelId: deleteField(),
      plantelName: deleteField(),
      updatedAt: serverTimestamp(),
    });
  });
  groupsSnap.docs.forEach((groupDoc) => {
    queueUpdate(updates, groupDoc.ref, {
      plantelId: deleteField(),
      plantelName: deleteField(),
      updatedAt: serverTimestamp(),
    });
  });
  groupStudentSnaps.forEach((studentsSnap) => {
    studentsSnap.docs.forEach((studentDoc) => {
      queueUpdate(updates, studentDoc.ref, {
        plantelId: deleteField(),
        plantelName: deleteField(),
        updatedAt: serverTimestamp(),
      });
    });
  });
  enrollmentsSnap.docs.forEach((enrollmentDoc) => {
    queueUpdate(updates, enrollmentDoc.ref, {
      plantelId: deleteField(),
      plantelName: deleteField(),
      updatedAt: serverTimestamp(),
    });
  });

  await commitQueuedUpdates(updates.values());
}

export async function getUserPlantelAssignments(userId: string): Promise<PlantelAssignment[]> {
  if (!userId) return [];
  const snap = await getDoc(doc(db, "users", userId));
  if (!snap.exists()) return [];
  const data = snap.data() as Record<string, unknown>;
  const assignments = getPlantelAssignmentsFromData(data);
  if (assignments.length === 0) return [];

  const resolvedAssignments = await Promise.all(
    assignments.map(async (assignment) => {
      if (assignment.plantelName) return assignment;
      const plantel = await getPlantel(assignment.plantelId);
      return {
        plantelId: assignment.plantelId,
        plantelName: plantel?.name ?? "",
      };
    }),
  );
  return dedupePlantelAssignments(resolvedAssignments);
}

export async function getUserPlantelAssignment(userId: string): Promise<PlantelAssignment | null> {
  const assignments = await getUserPlantelAssignments(userId);
  return assignments[0] ?? null;
}
