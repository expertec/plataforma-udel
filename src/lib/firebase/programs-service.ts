import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  writeBatch,
} from "firebase/firestore";
import { db } from "./firestore";

export type Program = {
  id: string;
  name: string;
  description?: string;
  coverUrl?: string;
  courseIds?: string[];
  status?: "active" | "archived";
  createdAt?: Date;
  updatedAt?: Date;
};

export async function getPrograms(): Promise<Program[]> {
  const ref = collection(db, "programs");
  const snap = await getDocs(query(ref, orderBy("createdAt", "desc")));
  return snap.docs.map((docSnap) => {
    const d = docSnap.data();
    return {
      id: docSnap.id,
      name: d.name ?? "Programa",
      description: d.description ?? "",
      coverUrl: d.coverUrl ?? "",
      courseIds: Array.isArray(d.courseIds) ? d.courseIds : [],
      status: d.status ?? "active",
      createdAt: d.createdAt?.toDate?.(),
      updatedAt: d.updatedAt?.toDate?.(),
    };
  });
}

export async function createProgram(data: {
  name: string;
  description?: string;
  coverUrl?: string;
}): Promise<string> {
  const ref = collection(db, "programs");
  const docRef = await addDoc(ref, {
    name: data.name.trim(),
    description: data.description ?? "",
    coverUrl: data.coverUrl ?? "",
    courseIds: [],
    status: "active",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return docRef.id;
}

export async function updateProgram(programId: string, data: Partial<Program>): Promise<void> {
  const ref = doc(db, "programs", programId);
  await updateDoc(ref, {
    ...data,
    updatedAt: serverTimestamp(),
  });
}

export async function deleteProgram(programId: string): Promise<void> {
  const ref = doc(db, "programs", programId);
  await deleteDoc(ref);
}

export async function syncCourseProgram(courseId: string, programName?: string): Promise<void> {
  if (!courseId) return;
  const trimmed = (programName ?? "").trim();
  const ref = collection(db, "programs");
  const snap = await getDocs(query(ref));
  if (snap.empty) return;

  const batch = writeBatch(db);
  let hasUpdates = false;

  snap.docs.forEach((docSnap) => {
    const d = docSnap.data();
    const name = (d.name ?? "").toString();
    const currentIds = Array.isArray(d.courseIds) ? d.courseIds : [];
    const hasCourse = currentIds.includes(courseId);
    const shouldHave = Boolean(trimmed) && name === trimmed;

    if (shouldHave && !hasCourse) {
      batch.update(docSnap.ref, { courseIds: [...currentIds, courseId], updatedAt: serverTimestamp() });
      hasUpdates = true;
      return;
    }
    if (!shouldHave && hasCourse) {
      batch.update(docSnap.ref, { courseIds: currentIds.filter((id: string) => id !== courseId), updatedAt: serverTimestamp() });
      hasUpdates = true;
    }
  });

  if (hasUpdates) {
    await batch.commit();
  }
}

export async function syncProgramsFromCourses(): Promise<void> {
  const programsSnap = await getDocs(collection(db, "programs"));
  if (programsSnap.empty) return;

  const programs = programsSnap.docs.map((docSnap) => {
    const d = docSnap.data();
    return {
      ref: docSnap.ref,
      name: (d.name ?? "").toString(),
      courseIds: Array.isArray(d.courseIds) ? d.courseIds : [],
    };
  });

  const coursesSnap = await getDocs(collection(db, "courses"));
  const programMap = new Map<string, string[]>();
  coursesSnap.docs.forEach((docSnap) => {
    const d = docSnap.data();
    const program = (d.program ?? d.category ?? "").toString().trim();
    if (!program) return;
    const list = programMap.get(program) ?? [];
    list.push(docSnap.id);
    programMap.set(program, list);
  });

  let batch = writeBatch(db);
  let ops = 0;
  const commitBatch = async () => {
    if (ops === 0) return;
    await batch.commit();
    batch = writeBatch(db);
    ops = 0;
  };

  for (const program of programs) {
    const desired = Array.from(new Set(programMap.get(program.name) ?? []));
    const current = program.courseIds;
    const currentSet = new Set(current);
    const desiredSet = new Set(desired);
    const hasDiff =
      current.length !== desired.length ||
      desired.some((id) => !currentSet.has(id)) ||
      current.some((id) => !desiredSet.has(id));
    if (!hasDiff) continue;
    batch.update(program.ref, { courseIds: desired, updatedAt: serverTimestamp() });
    ops += 1;
    if (ops >= 400) {
      await commitBatch();
    }
  }

  await commitBatch();
}
