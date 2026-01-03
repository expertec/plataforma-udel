import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  increment,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
  setDoc,
  getDoc,
} from "firebase/firestore";
import { db } from "./firestore";

export type Course = {
  id: string;
  title: string;
  description?: string;
  thumbnail?: string;
  isPublished: boolean;
  lessonsCount: number;
  studentsCount: number;
  introVideoUrl?: string;
  category?: string;
  createdAt?: Date;
};

export async function getCourses(teacherId: string): Promise<Course[]> {
  const coursesRef = collection(db, "courses");
  const q = query(
    coursesRef,
    where("teacherId", "==", teacherId),
    orderBy("createdAt", "desc"),
  );

  const snap = await getDocs(q);
  return snap.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      title: data.title ?? "Curso sin título",
      description: data.description ?? "",
      thumbnail: data.thumbnail ?? "",
      isPublished: Boolean(data.isPublished),
      lessonsCount: data.lessonsCount ?? 0,
      studentsCount: data.studentsCount ?? 0,
      introVideoUrl: data.introVideoUrl ?? "",
      category: data.category ?? "",
      createdAt: data.createdAt?.toDate?.() ?? undefined,
    };
  });
}

type CreateCourseInput = {
  title: string;
  description?: string;
  introVideoUrl?: string;
  category?: string;
  teacherId: string;
  teacherName?: string;
};

export async function createCourse(input: CreateCourseInput): Promise<string> {
  const coursesRef = collection(db, "courses");
  const docRef = await addDoc(coursesRef, {
    title: input.title,
    description: input.description ?? "",
    introVideoUrl: input.introVideoUrl ?? "",
    category: input.category ?? "",
    teacherId: input.teacherId,
    teacherName: input.teacherName ?? "",
    isPublished: false,
    createdAt: serverTimestamp(),
    lessonsCount: 0,
    studentsCount: 0,
  });

  return docRef.id;
}

type UpdateCourseInput = {
  title?: string;
  description?: string;
  introVideoUrl?: string;
  category?: string;
  thumbnail?: string;
  isPublished?: boolean;
};

export async function updateCourse(courseId: string, data: UpdateCourseInput): Promise<void> {
  const courseRef = doc(db, "courses", courseId);
  await updateDoc(courseRef, data);
}

export type Lesson = {
  id: string;
  lessonNumber: number;
  title: string;
  description?: string;
  order: number;
};

export async function getLessons(courseId: string): Promise<Lesson[]> {
  const lessonsRef = collection(db, "courses", courseId, "lessons");
  const q = query(lessonsRef, orderBy("order", "asc"));
  const snap = await getDocs(q);
  return snap.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      lessonNumber: data.lessonNumber ?? data.order ?? 1,
      title: data.title ?? "Lección sin título",
      description: data.description ?? "",
      order: data.order ?? 0,
    };
  });
}

type CreateLessonInput = {
  courseId: string;
  title: string;
  description?: string;
  lessonNumber: number;
  order: number;
};

export async function createLesson(input: CreateLessonInput): Promise<string> {
  const lessonsRef = collection(db, "courses", input.courseId, "lessons");
  const docRef = await addDoc(lessonsRef, {
    lessonNumber: input.lessonNumber,
    title: input.title,
    description: input.description ?? "",
    order: input.order,
    createdAt: serverTimestamp(),
  });
  // Incrementa contador de lecciones en el curso
  const courseRef = doc(db, "courses", input.courseId);
  await updateDoc(courseRef, { lessonsCount: increment(1) });
  return docRef.id;
}

export async function deleteLesson(courseId: string, lessonId: string): Promise<void> {
  const lessonRef = doc(db, "courses", courseId, "lessons", lessonId);
  await deleteDoc(lessonRef);
  const courseRef = doc(db, "courses", courseId);
  await updateDoc(courseRef, { lessonsCount: increment(-1) });
}

export type ClassItem = {
  id: string;
  title: string;
  type: "video" | "text" | "audio" | "quiz" | "image";
  order: number;
  duration?: number | null;
  videoUrl?: string | null;
  content?: string | null;
  audioUrl?: string | null;
  imageUrls?: string[] | null;
  hasAssignment?: boolean;
  assignmentTemplateUrl?: string | null;
};

export async function getClasses(courseId: string, lessonId: string): Promise<ClassItem[]> {
  const classesRef = collection(db, "courses", courseId, "lessons", lessonId, "classes");
  const q = query(classesRef, orderBy("order", "asc"));
  const snap = await getDocs(q);
  return snap.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      title: data.title ?? "Clase sin título",
      type: data.type ?? "video",
      order: data.order ?? 0,
      duration: data.duration,
      videoUrl: data.videoUrl ?? "",
      content: data.content ?? "",
      audioUrl: data.audioUrl ?? "",
      imageUrls: data.imageUrls ?? [],
      hasAssignment: data.hasAssignment ?? false,
      assignmentTemplateUrl: data.assignmentTemplateUrl ?? "",
    };
  });
}

type CreateClassInput = {
  courseId: string;
  lessonId: string;
  title: string;
  type: "video" | "text" | "audio" | "quiz" | "image";
  order: number;
  duration?: number;
  videoUrl?: string;
  content?: string;
  audioUrl?: string;
  imageUrls?: string[];
  hasAssignment?: boolean;
  assignmentTemplateUrl?: string | null;
};

export async function createClass(input: CreateClassInput): Promise<string> {
  const classesRef = collection(
    db,
    "courses",
    input.courseId,
    "lessons",
    input.lessonId,
    "classes",
  );
  const docRef = await addDoc(classesRef, {
    title: input.title,
    type: input.type,
    order: input.order,
    duration: input.duration ?? null,
    videoUrl: input.videoUrl ?? "",
    content: input.content ?? "",
    audioUrl: input.audioUrl ?? "",
    imageUrls: input.imageUrls ?? [],
    hasAssignment: input.hasAssignment ?? false,
    assignmentTemplateUrl: input.assignmentTemplateUrl ?? "",
    createdAt: serverTimestamp(),
  });
  return docRef.id;
}

type UpdateClassInput = {
  courseId: string;
  lessonId: string;
  classId: string;
  title?: string;
  type?: "video" | "text" | "audio" | "quiz" | "image";
  order?: number;
  duration?: number | null;
  videoUrl?: string | null;
  content?: string | null;
  audioUrl?: string | null;
  imageUrls?: string[] | null;
  hasAssignment?: boolean;
  assignmentTemplateUrl?: string | null;
};

export async function updateClass(input: UpdateClassInput): Promise<void> {
  const classRef = doc(
    db,
    "courses",
    input.courseId,
    "lessons",
    input.lessonId,
    "classes",
    input.classId,
  );
  const payload: Record<string, unknown> = {};
  if (input.title !== undefined) payload.title = input.title;
  if (input.type !== undefined) payload.type = input.type;
  if (input.order !== undefined) payload.order = input.order;
  if (input.duration !== undefined) payload.duration = input.duration;
  if (input.videoUrl !== undefined) payload.videoUrl = input.videoUrl;
  if (input.content !== undefined) payload.content = input.content;
  if (input.audioUrl !== undefined) payload.audioUrl = input.audioUrl;
  if (input.imageUrls !== undefined) payload.imageUrls = input.imageUrls;
  if (input.hasAssignment !== undefined) payload.hasAssignment = input.hasAssignment;
  if (input.assignmentTemplateUrl !== undefined)
    payload.assignmentTemplateUrl = input.assignmentTemplateUrl;
  if (Object.keys(payload).length === 0) return;
  await updateDoc(classRef, payload);
}

export async function deleteClass(
  courseId: string,
  lessonId: string,
  classId: string,
): Promise<void> {
  const classRef = doc(
    db,
    "courses",
    courseId,
    "lessons",
    lessonId,
    "classes",
    classId,
  );
  await deleteDoc(classRef);
}

export async function publishCourse(courseId: string, isPublished: boolean): Promise<void> {
  const courseRef = doc(db, "courses", courseId);
  await updateDoc(courseRef, { isPublished });
}

/* ===== Quiz Questions ===== */

export type QuizQuestion = {
  id: string;
  prompt: string;
  type: "multiple" | "truefalse" | "open";
  order: number;
  options: Array<{ id: string; text: string; isCorrect: boolean }>;
  answerText?: string;
};

export async function getQuizQuestions(
  courseId: string,
  lessonId: string,
  classId: string,
): Promise<QuizQuestion[]> {
  const refQuestions = collection(
    db,
    "courses",
    courseId,
    "lessons",
    lessonId,
    "classes",
    classId,
    "questions",
  );
  const q = query(refQuestions, orderBy("order", "asc"));
  const snap = await getDocs(q);
  return snap.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      prompt: data.prompt ?? "",
      type: data.type ?? "multiple",
      order: data.order ?? 0,
      options: data.options ?? [],
      answerText: data.answerText,
    };
  });
}

type CreateQuizQuestionInput = {
  courseId: string;
  lessonId: string;
  classId: string;
  prompt: string;
  options: Array<{ id: string; text: string; isCorrect: boolean }>;
  order: number;
  type?: "multiple" | "truefalse" | "open";
  answerText?: string;
};

export async function createQuizQuestion(input: CreateQuizQuestionInput): Promise<string> {
  const refQuestions = collection(
    db,
    "courses",
    input.courseId,
    "lessons",
    input.lessonId,
    "classes",
    input.classId,
    "questions",
  );
  const docRef = await addDoc(refQuestions, {
    prompt: input.prompt,
    type: input.type ?? "multiple",
    options: input.options,
    order: input.order,
    answerText: input.answerText ?? null,
    createdAt: serverTimestamp(),
  });
  return docRef.id;
}

export async function deleteQuizQuestion(
  courseId: string,
  lessonId: string,
  classId: string,
  questionId: string,
): Promise<void> {
  const refQuestion = doc(
    db,
    "courses",
    courseId,
    "lessons",
    lessonId,
    "classes",
    classId,
    "questions",
    questionId,
  );
  await deleteDoc(refQuestion);
}

/* ===== Enrollments & progreso ===== */

export type Enrollment = {
  userId: string;
  courseId: string;
  status: "active" | "completed" | "dropped";
  startedAt?: Date;
  completedAt?: Date;
  progress?: {
    lessonsCompleted: number;
    classesCompleted: number;
    quizzesCompleted: number;
    scoreAvg?: number;
  };
};

export async function enrollStudent(
  courseId: string,
  userId: string,
  assignedBy?: string,
): Promise<void> {
  const enrRef = doc(db, "courses", courseId, "enrollments", userId);
  await setDoc(
    enrRef,
    {
      userId,
      courseId,
      assignedBy: assignedBy ?? null,
      status: "active",
      startedAt: serverTimestamp(),
      progress: {
        lessonsCompleted: 0,
        classesCompleted: 0,
        quizzesCompleted: 0,
        scoreAvg: 0,
      },
    },
    { merge: true },
  );
  const courseRef = doc(db, "courses", courseId);
  await updateDoc(courseRef, { studentsCount: increment(1) });
}

export async function getEnrollment(
  courseId: string,
  userId: string,
): Promise<Enrollment | null> {
  const enrRef = doc(db, "courses", courseId, "enrollments", userId);
  const snap = await getDoc(enrRef);
  if (!snap.exists()) return null;
  const data = snap.data();
  return {
    userId,
    courseId,
    status: data.status ?? "active",
    startedAt: data.startedAt?.toDate?.(),
    completedAt: data.completedAt?.toDate?.(),
    progress: data.progress,
  };
}

export async function updateEnrollmentProgress(
  courseId: string,
  userId: string,
  progress: Partial<Enrollment["progress"]>,
  status?: Enrollment["status"],
): Promise<void> {
  const enrRef = doc(db, "courses", courseId, "enrollments", userId);
  const payload: Record<string, unknown> = { progress };
  if (status) payload.status = status;
  if (status === "completed") payload.completedAt = serverTimestamp();
  await setDoc(enrRef, payload, { merge: true });
}

/* ===== Progreso por clase / quiz ===== */

export async function markClassCompleted(
  courseId: string,
  lessonId: string,
  classId: string,
  userId: string,
): Promise<void> {
  const respRef = doc(
    db,
    "courses",
    courseId,
    "lessons",
    lessonId,
    "classes",
    classId,
    "responses",
    userId,
  );
  await setDoc(
    respRef,
    {
      completedAt: serverTimestamp(),
    },
    { merge: true },
  );
}

export async function recordQuizResponse(params: {
  courseId: string;
  lessonId: string;
  classId: string;
  userId: string;
  score: number;
  answers: Array<{
    questionId: string;
    optionId?: string;
    text?: string;
    isCorrect?: boolean;
  }>;
  passed: boolean;
}): Promise<void> {
  const { courseId, lessonId, classId, userId, score, answers, passed } = params;
  const respRef = doc(
    db,
    "courses",
    courseId,
    "lessons",
    lessonId,
    "classes",
    classId,
    "responses",
    userId,
  );
  await setDoc(respRef, {
    score,
    answers,
    passed,
    submittedAt: serverTimestamp(),
  });
}
