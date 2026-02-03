import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  increment,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
  setDoc,
  getDoc,
  writeBatch,
  QueryConstraint,
} from "firebase/firestore";
import { db } from "./firestore";
import { syncCourseProgram } from "./programs-service";

export type Course = {
  id: string;
  title: string;
  description?: string;
  thumbnail?: string;
  isArchived?: boolean;
  isPublished: boolean;
  lessonsCount: number;
  studentsCount: number;
  introVideoUrl?: string;
  // Usamos program como campo principal; mantenemos category como alias legacy
  program?: string;
  category?: string;
  createdAt?: Date;
  isMentorCourse?: boolean; // Indica si el curso pertenece a un grupo donde el usuario es mentor
  teacherId?: string; // ID del profesor creador del curso
};

/**
 * Obtiene los cursos con límite opcional para reducir lecturas de Firestore
 * @param teacherId - ID del profesor (opcional, si no se pasa devuelve todos)
 * @param maxResults - Límite de resultados (opcional)
 */
export async function getCourses(teacherId?: string, maxResults?: number): Promise<Course[]> {
  const coursesRef = collection(db, "courses");

  if (!teacherId) {
    // Sin teacherId, devolver todos los cursos (con límite opcional)
    const constraints: QueryConstraint[] = [orderBy("createdAt", "desc")];
    if (typeof maxResults === "number" && maxResults > 0) {
      constraints.push(limit(maxResults));
    }
    const q = query(coursesRef, ...constraints);
    const snap = await getDocs(q);
    return snap.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        title: data.title ?? "Curso sin título",
        description: data.description ?? "",
        thumbnail: data.thumbnail ?? "",
        isArchived: data.isArchived ?? false,
        isPublished: Boolean(data.isPublished),
        lessonsCount: data.lessonsCount ?? 0,
        studentsCount: data.studentsCount ?? 0,
        introVideoUrl: data.introVideoUrl ?? "",
        program: data.program ?? data.category ?? "",
        category: data.category ?? data.program ?? "",
        createdAt: data.createdAt?.toDate?.() ?? undefined,
        teacherId: data.teacherId,
        isMentorCourse: false,
      };
    });
  }

  // Con teacherId: obtener cursos propios + cursos de grupos donde es mentor
  const constraints: QueryConstraint[] = [
    where("teacherId", "==", teacherId),
    orderBy("createdAt", "desc"),
  ];
  if (typeof maxResults === "number" && maxResults > 0) {
    constraints.push(limit(maxResults));
  }
  const q = query(coursesRef, ...constraints);

  const snap = await getDocs(q);
  const ownCourses = snap.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      title: data.title ?? "Curso sin título",
      description: data.description ?? "",
      thumbnail: data.thumbnail ?? "",
      isArchived: data.isArchived ?? false,
      isPublished: Boolean(data.isPublished),
      lessonsCount: data.lessonsCount ?? 0,
      studentsCount: data.studentsCount ?? 0,
      introVideoUrl: data.introVideoUrl ?? "",
      program: data.program ?? data.category ?? "",
      category: data.category ?? data.program ?? "",
      createdAt: data.createdAt?.toDate?.() ?? undefined,
      teacherId: data.teacherId,
      isMentorCourse: false,
    };
  });

  // Obtener grupos donde es mentor
  const groupsRef = collection(db, "groups");
  const mentorGroupsQuery = query(
    groupsRef,
    where("assistantTeacherIds", "array-contains", teacherId)
  );

  const mentorGroupsSnap = await getDocs(mentorGroupsQuery);

  // Recolectar IDs únicos de cursos de los grupos donde es mentor
  const mentorCourseIds = new Set<string>();
  mentorGroupsSnap.docs.forEach((doc) => {
    const data = doc.data();
    // Agregar courseId legacy si existe
    if (data.courseId) {
      mentorCourseIds.add(data.courseId);
    }
    // Agregar courseIds del array si existe
    if (Array.isArray(data.courseIds)) {
      data.courseIds.forEach((id: string) => mentorCourseIds.add(id));
    }
  });

  // Si no hay cursos de mentoría, retornar solo los propios
  if (mentorCourseIds.size === 0) {
    return ownCourses;
  }

  // Obtener los cursos de mentoría (en lotes de 30 porque Firestore tiene límite de 30 en 'in')
  const mentorCourseIdsArray = Array.from(mentorCourseIds);
  const mentorCourses: Course[] = [];

  // Filtrar los cursos que ya son propios para evitar duplicados
  const ownCourseIds = new Set(ownCourses.map(c => c.id));
  const uniqueMentorCourseIds = mentorCourseIdsArray.filter(id => !ownCourseIds.has(id));

  // Procesar en lotes de 30
  for (let i = 0; i < uniqueMentorCourseIds.length; i += 30) {
    const batch = uniqueMentorCourseIds.slice(i, i + 30);
    const mentorCoursesQuery = query(
      coursesRef,
      where("__name__", "in", batch)
    );

    const mentorCoursesSnap = await getDocs(mentorCoursesQuery);
    mentorCoursesSnap.docs.forEach((doc) => {
      const data = doc.data();
      mentorCourses.push({
        id: doc.id,
        title: data.title ?? "Curso sin título",
        description: data.description ?? "",
        thumbnail: data.thumbnail ?? "",
        isArchived: data.isArchived ?? false,
        isPublished: Boolean(data.isPublished),
        lessonsCount: data.lessonsCount ?? 0,
        studentsCount: data.studentsCount ?? 0,
        introVideoUrl: data.introVideoUrl ?? "",
        program: data.program ?? data.category ?? "",
        category: data.category ?? data.program ?? "",
        createdAt: data.createdAt?.toDate?.() ?? undefined,
        teacherId: data.teacherId,
        isMentorCourse: true,
      });
    });
  }

  // Combinar y ordenar por fecha
  const allCourses = [...ownCourses, ...mentorCourses];
  allCourses.sort((a, b) => {
    const dateA = a.createdAt?.getTime() ?? 0;
    const dateB = b.createdAt?.getTime() ?? 0;
    return dateB - dateA; // Orden descendente (más reciente primero)
  });

  // Aplicar límite si se especifica
  if (typeof maxResults === "number" && maxResults > 0) {
    return allCourses.slice(0, maxResults);
  }

  return allCourses;
}

type CreateCourseInput = {
  title: string;
  description?: string;
  introVideoUrl?: string;
  program?: string;
  category?: string; // alias legacy
  teacherId: string;
  teacherName?: string;
};

export async function createCourse(input: CreateCourseInput): Promise<string> {
  const coursesRef = collection(db, "courses");
  const program = input.program ?? input.category ?? "";
  const docRef = await addDoc(coursesRef, {
    title: input.title,
    description: input.description ?? "",
    introVideoUrl: input.introVideoUrl ?? "",
    program,
    category: program, // mantener espejo para clientes antiguos
    teacherId: input.teacherId,
    teacherName: input.teacherName ?? "",
    isArchived: false,
    isPublished: false,
    createdAt: serverTimestamp(),
    lessonsCount: 0,
    studentsCount: 0,
  });

  if (program) {
    await syncCourseProgram(docRef.id, program);
  }

  return docRef.id;
}

type UpdateCourseInput = {
  title?: string;
  description?: string;
    introVideoUrl?: string;
    program?: string;
    category?: string; // alias legacy
    thumbnail?: string;
  isArchived?: boolean;
    isPublished?: boolean;
  };

export async function updateCourse(courseId: string, data: UpdateCourseInput): Promise<void> {
  const courseRef = doc(db, "courses", courseId);
  const program = data.program ?? data.category;
  const payload = program !== undefined ? { ...data, program, category: program } : data;
  await updateDoc(courseRef, payload);
  if (program !== undefined) {
    await syncCourseProgram(courseId, program);
  }
}

/**
 * Agrega mentores (assistant teachers) al array mentorIds de un curso
 */
export async function addMentorsToCourse(courseId: string, mentorIds: string[]): Promise<void> {
  if (!courseId || !mentorIds || mentorIds.length === 0) return;

  const courseRef = doc(db, "courses", courseId);
  const courseSnap = await getDoc(courseRef);

  if (!courseSnap.exists()) return;

  const currentMentorIds = courseSnap.data()?.mentorIds ?? [];
  const updatedMentorIds = Array.from(new Set([...currentMentorIds, ...mentorIds]));

  await updateDoc(courseRef, {
    mentorIds: updatedMentorIds,
  });
}

/**
 * Elimina mentores del array mentorIds de un curso
 */
export async function removeMentorsFromCourse(courseId: string, mentorIds: string[]): Promise<void> {
  if (!courseId || !mentorIds || mentorIds.length === 0) return;

  const courseRef = doc(db, "courses", courseId);
  const courseSnap = await getDoc(courseRef);

  if (!courseSnap.exists()) return;

  const currentMentorIds = courseSnap.data()?.mentorIds ?? [];
  const updatedMentorIds = currentMentorIds.filter((id: string) => !mentorIds.includes(id));

  await updateDoc(courseRef, {
    mentorIds: updatedMentorIds,
  });
}

/**
 * Sincroniza los mentorIds de los cursos cuando cambian los assistant teachers de un grupo
 */
export async function syncCourseMentors(
  courseIds: string[],
  mentorIds: string[]
): Promise<void> {
  if (!courseIds || courseIds.length === 0) return;

  // Actualizar cada curso con los mentores actuales
  const promises = courseIds.map(async (courseId) => {
    const courseRef = doc(db, "courses", courseId);
    await updateDoc(courseRef, {
      mentorIds: mentorIds,
    });
  });

  await Promise.all(promises);
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
  forumEnabled?: boolean;
  forumRequiredFormat?: "text" | "audio" | "video" | null;
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
      forumEnabled: data.forumEnabled ?? false,
      forumRequiredFormat: data.forumRequiredFormat ?? null,
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
  forumEnabled?: boolean;
  forumRequiredFormat?: "text" | "audio" | "video" | null;
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
    forumEnabled: input.forumEnabled ?? false,
    forumRequiredFormat: input.forumRequiredFormat ?? null,
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
  forumEnabled?: boolean;
  forumRequiredFormat?: "text" | "audio" | "video" | null;
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
  if (input.forumEnabled !== undefined) payload.forumEnabled = input.forumEnabled;
  if (input.forumRequiredFormat !== undefined) payload.forumRequiredFormat = input.forumRequiredFormat;
  if (Object.keys(payload).length === 0) return;
  await updateDoc(classRef, payload);
}

export async function reorderClasses(
  courseId: string,
  lessonId: string,
  classIds: string[],
): Promise<void> {
  if (!classIds.length) return;
  const batch = writeBatch(db);
  classIds.forEach((classId, index) => {
    const classRef = doc(db, "courses", courseId, "lessons", lessonId, "classes", classId);
    batch.update(classRef, { order: index });
  });
  await batch.commit();
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

export async function deleteCourse(courseId: string): Promise<void> {
  const courseRef = doc(db, "courses", courseId);

  // Firestore no elimina subcolecciones de forma automática, así que
  // las borramos en cascada (clases -> preguntas/comentarios/likes/respuestas -> lecciones).
  const lessonsSnap = await getDocs(collection(db, "courses", courseId, "lessons"));
  for (const lessonDoc of lessonsSnap.docs) {
    const lessonId = lessonDoc.id;
    const classesSnap = await getDocs(
      collection(db, "courses", courseId, "lessons", lessonId, "classes"),
    );
    for (const classDoc of classesSnap.docs) {
      const classRef = classDoc.ref;
      const nestedCollections = ["questions", "comments", "likes", "responses"];
      for (const nested of nestedCollections) {
        const nestedSnap = await getDocs(collection(classRef, nested));
        if (!nestedSnap.empty) {
          const batch = writeBatch(db);
          nestedSnap.docs.forEach((d) => batch.delete(d.ref));
          await batch.commit();
        }
      }
      await deleteDoc(classRef);
    }
    await deleteDoc(lessonDoc.ref);
  }

  // Inscripciones bajo el curso
  try {
    const enrollmentsSnap = await getDocs(collection(db, "courses", courseId, "enrollments"));
    for (const enrDoc of enrollmentsSnap.docs) {
      await deleteDoc(enrDoc.ref);
    }
  } catch (err) {
    // Puede fallar por reglas (no hay reglas explícitas para enrollments en /courses),
    // pero no debe bloquear el borrado principal.
    console.warn("No se pudieron eliminar las inscripciones del curso", courseId, err);
  }

  // Limpiar referencias en grupos (courseId y courseIds).
  try {
    const groupsRef = collection(db, "groups");
    const [snapByField, snapByArray] = await Promise.all([
      getDocs(query(groupsRef, where("courseId", "==", courseId))),
      getDocs(query(groupsRef, where("courseIds", "array-contains", courseId))),
    ]);
    const groupsMap = new Map<string, typeof snapByField.docs[number]>();
    snapByField.docs.forEach((d) => groupsMap.set(d.id, d));
    snapByArray.docs.forEach((d) => groupsMap.set(d.id, d));

    for (const groupDoc of groupsMap.values()) {
      const data = groupDoc.data();
      const nextCourses = Array.isArray(data.courses)
        ? data.courses.filter((c: { courseId?: string }) => c.courseId !== courseId)
        : [];
      const nextCourseIds = Array.isArray(data.courseIds)
        ? data.courseIds.filter((id: string) => id !== courseId)
        : [];
      const payload: Record<string, unknown> = {
        courses: nextCourses,
        courseIds: nextCourseIds,
        updatedAt: serverTimestamp(),
      };
      if (data.courseId === courseId) {
        payload.courseId = nextCourseIds[0] ?? "";
        payload.courseName = nextCourses[0]?.courseName ?? "";
      }
      await updateDoc(groupDoc.ref, payload);
    }
  } catch (err) {
    // Si no se pueden limpiar los grupos (p. ej. permisos), no bloqueamos el borrado del curso.
    console.warn("No se pudieron limpiar referencias de grupos para el curso", courseId, err);
  }

  await deleteDoc(courseRef);
}

/* ===== Quiz Questions ===== */

export type QuizQuestion = {
  id: string;
  prompt: string;
  type: "multiple" | "truefalse" | "open";
  order: number;
  explanation?: string;
  options: Array<{
    id: string;
    text: string;
    isCorrect: boolean;
    feedback?: string;
    correctFeedback?: string;
    incorrectFeedback?: string;
  }>;
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
      explanation: data.explanation ?? data.questionFeedback ?? "",
      type: data.type ?? "multiple",
      order: data.order ?? 0,
      options: (data.options ?? []).map((opt: any) => ({
        id: opt.id,
        text: opt.text,
        isCorrect: opt.isCorrect,
        feedback: opt.feedback,
        correctFeedback: opt.correctFeedback,
        incorrectFeedback: opt.incorrectFeedback,
      })),
      answerText: data.answerText,
    };
  });
}

type CreateQuizQuestionInput = {
  courseId: string;
  lessonId: string;
  classId: string;
  prompt: string;
  explanation?: string;
  options: Array<{
    id: string;
    text: string;
    isCorrect: boolean;
    feedback?: string;
    correctFeedback?: string;
    incorrectFeedback?: string;
  }>;
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
    explanation: input.explanation ?? null,
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
