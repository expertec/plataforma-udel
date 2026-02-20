import {
  addDoc,
  collection,
  doc,
  getDocs,
  getDoc,
  limit,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
  updateDoc,
  where,
  deleteDoc,
} from "firebase/firestore";
import { db } from "@/lib/firebase/firestore";

export type SubmissionStatus = "pending" | "graded" | "late";

export type Submission = {
  id: string;
  classId: string;
  classDocId?: string;
  courseId?: string;
  courseTitle?: string;
  lessonId?: string;
  lessonTitle?: string;
  className: string;
  classType: string;
  studentId: string;
  studentName: string;
  submittedAt?: Date | null;
  fileUrl?: string;
  audioUrl?: string;
  content?: string;
  status: SubmissionStatus;
  grade?: number;
  feedback?: string;
  gradedAt?: Date | null;
};

type CreateSubmissionInput = {
  classId: string;
  classDocId?: string;
  courseId?: string;
  courseTitle?: string;
  lessonId?: string;
  lessonTitle?: string;
  className: string;
  classType: string;
  studentId: string;
  studentName: string;
  submittedAt?: Date;
  fileUrl?: string;
  audioUrl?: string;
  content?: string;
  status?: SubmissionStatus;
  grade?: number;
  answers?: unknown[];
};

export async function createSubmission(
  groupId: string,
  data: CreateSubmissionInput,
): Promise<string> {
  // Validar estado del grupo antes de permitir la entrega
  const groupRef = doc(db, "groups", groupId);
  const groupSnap = await getDoc(groupRef);
  if (!groupSnap.exists()) {
    throw new Error("El grupo no existe");
  }
  const groupData = groupSnap.data();
  if (groupData.status && groupData.status !== "active") {
    throw new Error("El período de entregas ha finalizado");
  }

  const courseId = (data.courseId ?? "").trim();
  if (courseId && data.studentId) {
    let enrollmentData: Record<string, unknown> | null = null;
    const canonicalEnrollmentRef = doc(db, "studentEnrollments", `${groupId}_${data.studentId}`);
    const canonicalEnrollmentSnap = await getDoc(canonicalEnrollmentRef);
    if (canonicalEnrollmentSnap.exists()) {
      enrollmentData = canonicalEnrollmentSnap.data() as Record<string, unknown>;
    } else {
      const enrollmentSnap = await getDocs(
        query(
          collection(db, "studentEnrollments"),
          where("groupId", "==", groupId),
          where("studentId", "==", data.studentId),
          limit(1),
        ),
      );
      if (!enrollmentSnap.empty) {
        enrollmentData = enrollmentSnap.docs[0].data() as Record<string, unknown>;
      }
    }

    if (enrollmentData) {
      const closures = (enrollmentData.courseClosures ?? {}) as Record<string, { status?: string } | undefined>;
      const closure = closures[courseId];
      if (closure?.status === "closed") {
        throw new Error("Este curso está cerrado para el alumno.");
      }
    }
  }

  const ref = collection(db, "groups", groupId, "submissions");
  const docRef = await addDoc(ref, {
    classId: data.classId,
    ...(data.classDocId ? { classDocId: data.classDocId } : {}),
    ...(data.courseId ? { courseId: data.courseId } : {}),
    ...(data.courseTitle ? { courseTitle: data.courseTitle } : {}),
    ...(data.lessonId ? { lessonId: data.lessonId } : {}),
    ...(data.lessonTitle ? { lessonTitle: data.lessonTitle } : {}),
    className: data.className,
    classType: data.classType,
    studentId: data.studentId,
    studentName: data.studentName,
    submittedAt: data.submittedAt ? Timestamp.fromDate(data.submittedAt) : serverTimestamp(),
    fileUrl: data.fileUrl ?? "",
    audioUrl: data.audioUrl ?? "",
    content: data.content ?? "",
    status: data.status ?? "pending",
    ...(typeof data.grade === "number" ? { grade: data.grade, gradedAt: serverTimestamp() } : {}),
    ...(data.answers ? { answers: data.answers } : {}),
  });
  return docRef.id;
}

export async function getSubmissionsByClass(
  groupId: string,
  classId: string,
): Promise<Submission[]> {
  const ref = collection(db, "groups", groupId, "submissions");
  const q = query(ref, where("classId", "==", classId), orderBy("submittedAt", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map((d) => toSubmission(d.id, d.data()));
}

export async function getAllSubmissions(groupId: string): Promise<Submission[]> {
  const ref = collection(db, "groups", groupId, "submissions");
  const q = query(ref, orderBy("submittedAt", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map((d) => toSubmission(d.id, d.data()));
}

export async function gradeSubmission(
  groupId: string,
  submissionId: string,
  grade: number,
  feedback: string,
): Promise<void> {
  const ref = doc(db, "groups", groupId, "submissions", submissionId);
  await updateDoc(ref, {
    grade,
    feedback,
    gradedAt: serverTimestamp(),
    status: "graded",
  });
}

export async function getStudentSubmissions(
  groupId: string,
  studentId: string,
): Promise<Submission[]> {
  const ref = collection(db, "groups", groupId, "submissions");
  const q = query(ref, where("studentId", "==", studentId), orderBy("submittedAt", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map((d) => toSubmission(d.id, d.data()));
}

export async function deleteSubmission(
  groupId: string,
  submissionId: string,
): Promise<void> {
  const ref = doc(db, "groups", groupId, "submissions", submissionId);
  await deleteDoc(ref);
}

type SubmissionData = {
  classId?: string;
  classDocId?: string;
  courseId?: string;
  courseTitle?: string;
  lessonId?: string;
  lessonTitle?: string;
  className?: string;
  classType?: string;
  studentId?: string;
  studentName?: string;
  submittedAt?: { toDate?: () => Date };
  fileUrl?: string;
  audioUrl?: string;
  content?: string;
  status?: SubmissionStatus | string;
  grade?: number;
  feedback?: string;
  gradedAt?: { toDate?: () => Date };
};

function toSubmission(id: string, data: SubmissionData): Submission {
  const status = ["pending", "graded", "late"].includes((data.status as string) ?? "")
    ? (data.status as SubmissionStatus)
    : "pending";
  return {
    id,
    classId: data.classId ?? "",
    classDocId: data.classDocId,
    courseId: data.courseId,
    courseTitle: data.courseTitle,
    lessonId: data.lessonId,
    lessonTitle: data.lessonTitle,
    className: data.className ?? "",
    classType: data.classType ?? "",
    studentId: data.studentId ?? "",
    studentName: data.studentName ?? "",
    submittedAt: data.submittedAt?.toDate?.() ?? null,
    fileUrl: data.fileUrl ?? "",
    audioUrl: data.audioUrl ?? "",
    content: data.content ?? "",
    status,
    grade: data.grade ?? undefined,
    feedback: data.feedback ?? "",
    gradedAt: data.gradedAt?.toDate?.() ?? null,
  };
}
