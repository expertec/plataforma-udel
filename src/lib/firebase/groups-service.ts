import {
  DocumentData,
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
  updateDoc,
  QuerySnapshot,
  QueryDocumentSnapshot,
} from "firebase/firestore";
import { db } from "@/lib/firebase/firestore";
import { doc as firestoreDoc } from "firebase/firestore";

export type Group = {
  id: string;
  courseId: string;
  courseName: string;
  courses?: Array<{ courseId: string; courseName: string }>;
  courseIds?: string[];
  groupName: string;
  teacherId: string;
  teacherName: string;
  assistantTeacherIds?: string[];
  assistantTeachers?: Array<{ id: string; name: string; email?: string }>;
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
  courses?: Array<{ courseId: string; courseName: string }>;
  courseIds?: string[];
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
  const coursesList =
    data.courses && data.courses.length > 0
      ? data.courses
      : [{ courseId: data.courseId, courseName: data.courseName }];
  const courseIdsList =
    data.courseIds && data.courseIds.length > 0
      ? Array.from(new Set(data.courseIds))
      : Array.from(new Set(coursesList.map((c) => c.courseId).filter(Boolean)));
  const docRef = await addDoc(ref, {
    courseId: data.courseId,
    courseName: data.courseName,
    courses: coursesList,
    courseIds: courseIdsList,
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
      courses: Array.isArray(d.courses)
        ? d.courses
        : d.courseId
          ? [{ courseId: d.courseId ?? "", courseName: d.courseName ?? "" }]
          : [],
      courseIds: Array.isArray(d.courseIds) && d.courseIds.length > 0
        ? d.courseIds
        : d.courseId
          ? [d.courseId]
          : [],
      groupName: d.groupName ?? "",
      teacherId: d.teacherId ?? "",
      teacherName: d.teacherName ?? "",
      assistantTeacherIds: Array.isArray(d.assistantTeacherIds) ? d.assistantTeacherIds : [],
      assistantTeachers: Array.isArray(d.assistantTeachers) ? d.assistantTeachers : [],
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
    courses: Array.isArray(d.courses)
      ? d.courses
      : d.courseId
        ? [{ courseId: d.courseId ?? "", courseName: d.courseName ?? "" }]
        : [],
    courseIds: Array.isArray(d.courseIds) && d.courseIds.length > 0
      ? d.courseIds
      : d.courseId
        ? [d.courseId]
        : [],
    groupName: d.groupName ?? "",
    teacherId: d.teacherId ?? "",
    teacherName: d.teacherName ?? "",
    assistantTeacherIds: Array.isArray(d.assistantTeacherIds) ? d.assistantTeacherIds : [],
    assistantTeachers: Array.isArray(d.assistantTeachers) ? d.assistantTeachers : [],
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
  const constraintsBase: QueryConstraint[] = [orderBy("createdAt", "desc")];
  const constraintsByCourseId: QueryConstraint[] = [where("courseId", "==", courseId), ...constraintsBase];
  const constraintsByArray: QueryConstraint[] = [where("courseIds", "array-contains", courseId), ...constraintsBase];
  if (teacherId) {
    constraintsByCourseId.push(where("teacherId", "==", teacherId));
    constraintsByArray.push(where("teacherId", "==", teacherId));
  }

  // Ejecutar ambas consultas para cubrir documentos antiguos (courseId) y nuevos (courseIds)
  const [snapCourseId, snapArray] = await Promise.all([
    getDocs(query(ref, ...constraintsByCourseId)),
    getDocs(query(ref, ...constraintsByArray)),
  ]);
  const map = new Map<string, Group>();
  const consume = (snap: QuerySnapshot<DocumentData>) => {
    snap.docs.forEach((docSnap: QueryDocumentSnapshot<DocumentData>) => {
      const d = docSnap.data();
      map.set(docSnap.id, {
        id: docSnap.id,
        courseId: d.courseId ?? "",
        courseName: d.courseName ?? "",
        courses: Array.isArray(d.courses)
          ? d.courses
          : d.courseId
            ? [{ courseId: d.courseId ?? "", courseName: d.courseName ?? "" }]
            : [],
        courseIds: Array.isArray(d.courseIds) && d.courseIds.length > 0
          ? d.courseIds
          : d.courseId
            ? [d.courseId]
            : [],
        groupName: d.groupName ?? "",
        teacherId: d.teacherId ?? "",
        teacherName: d.teacherName ?? "",
        assistantTeacherIds: Array.isArray(d.assistantTeacherIds) ? d.assistantTeacherIds : [],
        assistantTeachers: Array.isArray(d.assistantTeachers) ? d.assistantTeachers : [],
        semester: d.semester ?? "",
        startDate: d.startDate?.toDate?.() ?? null,
        endDate: d.endDate?.toDate?.() ?? null,
        status: d.status ?? "active",
        studentsCount: d.studentsCount ?? 0,
        maxStudents: d.maxStudents ?? 0,
        createdAt: d.createdAt?.toDate?.(),
        updatedAt: d.updatedAt?.toDate?.(),
      });
    });
  };
  consume(snapCourseId);
  consume(snapArray);
  return Array.from(map.values());
}

export async function getActiveGroups(teacherId?: string): Promise<Group[]> {
  const ref = collection(db, "groups");
  const constraints: QueryConstraint[] = [orderBy("createdAt", "desc")];
  if (teacherId) {
    constraints.push(where("teacherId", "==", teacherId));
  }
  const snap = await getDocs(query(ref, ...constraints));
  return snap.docs
    .map((docSnap) => {
      const d = docSnap.data();
      return {
        id: docSnap.id,
        courseId: d.courseId ?? "",
        courseName: d.courseName ?? "",
        courses: Array.isArray(d.courses)
          ? d.courses
          : d.courseId
            ? [{ courseId: d.courseId ?? "", courseName: d.courseName ?? "" }]
            : [],
        courseIds: Array.isArray(d.courseIds) && d.courseIds.length > 0
          ? d.courseIds
          : d.courseId
            ? [d.courseId]
            : [],
        groupName: d.groupName ?? "",
        teacherId: d.teacherId ?? "",
        teacherName: d.teacherName ?? "",
        assistantTeacherIds: Array.isArray(d.assistantTeacherIds) ? d.assistantTeacherIds : [],
        assistantTeachers: Array.isArray(d.assistantTeachers) ? d.assistantTeachers : [],
        semester: d.semester ?? "",
        startDate: d.startDate?.toDate?.() ?? null,
        endDate: d.endDate?.toDate?.() ?? null,
        status: d.status ?? "active",
        studentsCount: d.studentsCount ?? 0,
        maxStudents: d.maxStudents ?? 0,
        createdAt: d.createdAt?.toDate?.(),
        updatedAt: d.updatedAt?.toDate?.(),
      };
    })
    .filter((g) => g.status === "active");
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

export async function linkCourseToGroup(params: {
  groupId: string;
  courseId: string;
  courseName: string;
}): Promise<void> {
  const { groupId, courseId, courseName } = params;
  const ref = doc(db, "groups", groupId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error("Grupo no encontrado");
  const data = snap.data();
  const courses: Array<{ courseId: string; courseName: string }> = Array.isArray(data.courses)
    ? data.courses
    : data.courseId
      ? [{ courseId: data.courseId, courseName: data.courseName ?? "" }]
      : [];
  const courseIds: string[] = Array.isArray(data.courseIds) ? data.courseIds : [];

  const hasCourse = courses.some((c) => c.courseId === courseId);
  const nextCourses = hasCourse ? courses : [...courses, { courseId, courseName }];
  const nextCourseIds = Array.from(new Set([...(courseIds || []), courseId]));

  await updateDoc(ref, {
    courses: nextCourses,
    courseIds: nextCourseIds,
    updatedAt: serverTimestamp(),
  });
}

export async function setAssistantTeachers(groupId: string, teachers: Array<{ id: string; name: string; email?: string }>) {
  if (!groupId) return;
  const ref = doc(db, "groups", groupId);
  await updateDoc(ref, {
    assistantTeacherIds: teachers.map((t) => t.id),
    assistantTeachers: teachers,
    updatedAt: serverTimestamp(),
  });
}
