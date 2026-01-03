import {
  addDoc,
  collection,
  doc,
  getDocs,
  increment,
  orderBy,
  QueryConstraint,
  query,
  serverTimestamp,
  Timestamp,
  where,
  getDoc,
  writeBatch,
} from "firebase/firestore";
import { db } from "@/lib/firebase/firestore";
import { doc as firestoreDoc } from "firebase/firestore";

export type Group = {
  id: string;
  courseId: string;
  courseName: string;
  groupName: string;
  teacherId: string;
  teacherName: string;
  semester: string;
  startDate?: Date | null;
  endDate?: Date | null;
  status: "active" | "finished" | "archived";
  studentsCount: number;
  maxStudents: number;
  createdAt?: Date;
  updatedAt?: Date;
};

type CreateGroupData = {
  courseId: string;
  courseName: string;
  groupName: string;
  teacherId: string;
  teacherName: string;
  semester: string;
  startDate?: Date;
  endDate?: Date;
  maxStudents: number;
};

export async function createGroup(data: CreateGroupData): Promise<string> {
  const ref = collection(db, "groups");
  const docRef = await addDoc(ref, {
    courseId: data.courseId,
    courseName: data.courseName,
    groupName: data.groupName,
    teacherId: data.teacherId,
    teacherName: data.teacherName,
    semester: data.semester,
    startDate: data.startDate ? Timestamp.fromDate(data.startDate) : null,
    endDate: data.endDate ? Timestamp.fromDate(data.endDate) : null,
    status: "active",
    studentsCount: 0,
    maxStudents: data.maxStudents,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return docRef.id;
}

export async function getGroups(teacherId: string): Promise<Group[]> {
  const ref = collection(db, "groups");
  const q = query(ref, where("teacherId", "==", teacherId), orderBy("createdAt", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map((docSnap) => {
    const d = docSnap.data();
    return {
      id: docSnap.id,
      courseId: d.courseId ?? "",
      courseName: d.courseName ?? "",
      groupName: d.groupName ?? "",
      teacherId: d.teacherId ?? "",
      teacherName: d.teacherName ?? "",
      semester: d.semester ?? "",
      startDate: d.startDate?.toDate?.() ?? null,
      endDate: d.endDate?.toDate?.() ?? null,
      status: d.status ?? "active",
      studentsCount: d.studentsCount ?? 0,
      maxStudents: d.maxStudents ?? 0,
      createdAt: d.createdAt?.toDate?.(),
      updatedAt: d.updatedAt?.toDate?.(),
    };
  });
}

export async function getGroup(groupId: string): Promise<Group | null> {
  const ref = doc(db, "groups", groupId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  const d = snap.data();
  return {
    id: snap.id,
    courseId: d.courseId ?? "",
    courseName: d.courseName ?? "",
    groupName: d.groupName ?? "",
    teacherId: d.teacherId ?? "",
    teacherName: d.teacherName ?? "",
    semester: d.semester ?? "",
    startDate: d.startDate?.toDate?.() ?? null,
    endDate: d.endDate?.toDate?.() ?? null,
    status: d.status ?? "active",
    studentsCount: d.studentsCount ?? 0,
    maxStudents: d.maxStudents ?? 0,
    createdAt: d.createdAt?.toDate?.(),
    updatedAt: d.updatedAt?.toDate?.(),
  };
}

export async function getGroupsByCourse(courseId: string, teacherId?: string): Promise<Group[]> {
  const ref = collection(db, "groups");
  const constraints: QueryConstraint[] = [
    where("courseId", "==", courseId),
    orderBy("createdAt", "desc"),
  ];
  if (teacherId) constraints.push(where("teacherId", "==", teacherId));
  const q = query(ref, ...constraints);
  const snap = await getDocs(q);
  return snap.docs.map((docSnap) => {
    const d = docSnap.data();
    return {
      id: docSnap.id,
      courseId: d.courseId ?? "",
      courseName: d.courseName ?? "",
      groupName: d.groupName ?? "",
      teacherId: d.teacherId ?? "",
      teacherName: d.teacherName ?? "",
      semester: d.semester ?? "",
      startDate: d.startDate?.toDate?.() ?? null,
      endDate: d.endDate?.toDate?.() ?? null,
      status: d.status ?? "active",
      studentsCount: d.studentsCount ?? 0,
      maxStudents: d.maxStudents ?? 0,
      createdAt: d.createdAt?.toDate?.(),
      updatedAt: d.updatedAt?.toDate?.(),
    };
  });
}

type AddStudentsInput = {
  groupId: string;
  students: Array<{ id: string; nombre: string; email: string }>;
};

export async function addStudentsToGroup({ groupId, students }: AddStudentsInput): Promise<void> {
  if (!groupId || students.length === 0) return;
  // Evitar duplicados: obtener los ya existentes
  const groupSnap = await getDoc(doc(db, "groups", groupId));
  if (!groupSnap.exists()) return;
  const groupData = groupSnap.data();

  const existingSnap = await getDocs(collection(db, "groups", groupId, "students"));
  const existingIds = new Set(existingSnap.docs.map((d) => d.id));
  const newStudents = students.filter((s) => !existingIds.has(s.id));
  if (newStudents.length === 0) return;

  const batch = writeBatch(db);
  const groupRef = doc(db, "groups", groupId);
  newStudents.forEach((student) => {
    const ref = doc(db, "groups", groupId, "students", student.id);
    batch.set(ref, {
      studentId: student.id,
      studentName: student.nombre,
      studentEmail: student.email,
      enrolledAt: serverTimestamp(),
      status: "active",
    });
  });
  batch.update(groupRef, {
    studentsCount: increment(newStudents.length),
    updatedAt: serverTimestamp(),
  });
  // Crear también el enrollment para cada alumno (evita que el feed quede sin curso asignado)
  newStudents.forEach((student) => {
    const enrollmentRef = firestoreDoc(
      db,
      "studentEnrollments",
      `${groupId}_${student.id}`,
    );
    batch.set(enrollmentRef, {
      studentId: student.id,
      studentName: student.nombre,
      studentEmail: student.email,
      groupId,
      groupName: groupData.groupName ?? "",
      courseId: groupData.courseId ?? "",
      courseName: groupData.courseName ?? "",
      teacherName: groupData.teacherName ?? "",
      status: "active",
      enrolledAt: serverTimestamp(),
      finalGrade: null,
    });
  });
  await batch.commit();
}

export type GroupStudent = {
  id: string;
  studentName: string;
  studentEmail: string;
  status: string;
  enrolledAt?: Date;
};

export async function getGroupStudents(groupId: string): Promise<GroupStudent[]> {
  const ref = collection(db, "groups", groupId, "students");
  const q = query(ref, orderBy("enrolledAt", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map((docSnap) => {
    const d = docSnap.data();
    return {
      id: docSnap.id,
      studentName: d.studentName ?? "",
      studentEmail: d.studentEmail ?? "",
      status: d.status ?? "active",
      enrolledAt: d.enrolledAt?.toDate?.(),
    };
  });
}

export async function removeStudentFromGroup(groupId: string, studentId: string): Promise<void> {
  if (!groupId || !studentId) return;
  const batch = writeBatch(db);
  const studentRef = doc(db, "groups", groupId, "students", studentId);
  batch.delete(studentRef);
  const groupRef = doc(db, "groups", groupId);
  batch.update(groupRef, {
    studentsCount: increment(-1),
    updatedAt: serverTimestamp(),
  });
  const enrollmentRef = doc(db, "studentEnrollments", `${groupId}_${studentId}`);
  batch.delete(enrollmentRef);
  await batch.commit();
}
