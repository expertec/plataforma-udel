import { FieldValue, type DocumentSnapshot, type Transaction } from "firebase-admin/firestore";
import { getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";
import { resolveCourseManagementAccess, type CourseManagementRole } from "@/lib/server/course-management-access";
import { distributeFinalExamPoints, finalExamOpensAt, FINAL_EXAM_POINTS, type FinalExamQuestion } from "@/lib/final-exams";
import { isStudentStatusBlocked } from "@/lib/students/status";

type Data = Record<string, unknown>;
const STAFF_ROLES = ["teacher", "adminTeacher", "superAdminTeacher", "coordinadorPlantel", "director"];
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
export class FinalExamError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function finalExamId(value: unknown): string {
  const id = text(value);
  if (!id || id.includes("/") || id === "." || id === ".." || id.length > 200) throw new FinalExamError(400, "Identificador inválido.");
  return id;
}

export async function finalExamUser(authorization: string | null) {
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new FinalExamError(401, "Inicia sesión para continuar.");
  let decoded;
  try { decoded = await getAdminAuth().verifyIdToken(token); }
  catch { throw new FinalExamError(401, "La sesión expiró."); }
  const snapshot = await getAdminFirestore().collection("users").doc(decoded.uid).get();
  if (!snapshot.exists) throw new FinalExamError(403, "No se encontró tu cuenta en la plataforma.");
  const data = snapshot.data() ?? {};
  if (isStudentStatusBlocked(data.estado ?? data.status)) throw new FinalExamError(403, "La cuenta está inactiva.");
  return { uid: decoded.uid, role: text(data.role ?? decoded.role), name: text(data.name) || text(data.displayName) || "Estudiante", plantelIds: [...strings(data.plantelIds), text(data.plantelId)].filter(Boolean) };
}

function normalizeQuestions(value: unknown): FinalExamQuestion[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 200) throw new FinalExamError(400, "Agrega entre 1 y 200 preguntas.");
  let points: number[];
  try { points = distributeFinalExamPoints(value.map((question) => typeof question?.pointValue === "number" ? question.pointValue : 1)); }
  catch (error) { throw new FinalExamError(400, error instanceof Error ? error.message : "Puntajes inválidos."); }
  const ids = new Set<string>();
  return value.map((question: Data, index) => {
    if (!question || typeof question !== "object") throw new FinalExamError(400, "Reactivo inválido.");
    const id = question.id ? finalExamId(question.id) : `question-${index + 1}`;
    if (ids.has(id)) throw new FinalExamError(400, "Hay identificadores de preguntas duplicados.");
    ids.add(id);
    const prompt = text(question.prompt);
    if (!prompt || prompt.length > 10000) throw new FinalExamError(400, "Revisa los enunciados de las preguntas.");
    if (question.type !== "multiple" && question.type !== "truefalse") throw new FinalExamError(400, "El examen final admite opción múltiple y verdadero/falso para calificación automática.");
    if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 10) throw new FinalExamError(400, "Cada reactivo necesita entre 2 y 10 opciones.");
    const optionIds = new Set<string>();
    const options = question.options.map((option: Data, optionIndex) => {
      if (!option || typeof option !== "object") throw new FinalExamError(400, "Opción inválida.");
      const optionId = text(option.id) || `option-${optionIndex + 1}`;
      const optionText = text(option.text);
      if (!optionText || optionText.length > 10000 || optionIds.has(optionId)) throw new FinalExamError(400, "Revisa las opciones y sus identificadores.");
      optionIds.add(optionId);
      return { id: optionId, text: optionText, isCorrect: option.isCorrect === true,
        feedback: text(option.feedback), correctFeedback: text(option.correctFeedback), incorrectFeedback: text(option.incorrectFeedback) };
    });
    if (options.filter((option) => option.isCorrect).length !== 1) throw new FinalExamError(400, "Cada pregunta debe tener una sola respuesta correcta.");
    return { id, prompt, explanation: text(question.explanation), type: question.type, order: index, pointValue: points[index], options };
  });
}

export async function saveFinalExam(courseId: string, body: Data, user: Awaited<ReturnType<typeof finalExamUser>>) {
  if (!STAFF_ROLES.includes(user.role)) throw new FinalExamError(403, "Solo el personal autorizado puede configurar el examen.");
  const access = await resolveCourseManagementAccess({ courseId, uid: user.uid, role: user.role as CourseManagementRole, coordinatorPlantelIds: user.plantelIds, AccessError: FinalExamError });
  if (!access.allowed) throw new FinalExamError(403, "No tienes acceso a esta materia.");
  const db = getAdminFirestore();
  const lessonId = finalExamId(body.lessonId);
  const courseRef = db.collection("courses").doc(courseId);
  const lessonRef = courseRef.collection("lessons").doc(lessonId);
  const classRef = body.classId ? lessonRef.collection("classes").doc(finalExamId(body.classId)) : lessonRef.collection("classes").doc();
  if (body.assessmentKind !== "regular" && body.assessmentKind !== "final") throw new FinalExamError(400, "Selecciona quiz semanal o examen final.");
  const kind = body.assessmentKind;
  const title = text(body.title);
  if (!title || title.length > 500) throw new FinalExamError(400, "El título es obligatorio (máximo 500 caracteres).");
  const questions = kind === "final" ? normalizeQuestions(body.questions) : null;
  const groups = body.classId ? await db.collection("groups").get() : null;
  await db.runTransaction(async (transaction) => {
    const [courseSnap, lessonSnap, currentSnap, previousQuestions] = await Promise.all([
      transaction.get(courseRef), transaction.get(lessonRef), transaction.get(classRef), transaction.get(classRef.collection("questions")),
    ]);
    if (!courseSnap.exists || !lessonSnap.exists) throw new FinalExamError(404, "No se encontró la materia o semana.");
    const current = currentSnap.data() ?? {};
    if (body.classId && !currentSnap.exists) throw new FinalExamError(404, "No se encontró el quiz.");
    if (currentSnap.exists && current.type !== "quiz") throw new FinalExamError(400, "Solo un quiz puede convertirse en examen final.");
    if ((current.assessmentVersion ?? 0) !== (body.version ?? 0)) throw new FinalExamError(409, "El examen cambió. Cierra y vuelve a abrir el editor.");
    if ((current.finalExamAttemptCount ?? 0) > 0) throw new FinalExamError(409, "El examen ya tiene respuestas. Sus preguntas y puntajes están protegidos.");
    if (body.classId && current.assessmentKind !== "final") {
      for (const group of groups!.docs) {
        const submissions = group.ref.collection("submissions");
        const [byClass, byDocument, byFeedId] = await Promise.all([
          transaction.get(submissions.where("classId", "==", classRef.id).limit(1)),
          transaction.get(submissions.where("classDocId", "==", classRef.id).limit(1)),
          transaction.get(submissions.where("classId", "==", `${group.id}_${courseId}_${classRef.id}`).limit(1)),
        ]);
        if (!byClass.empty || !byDocument.empty || !byFeedId.empty) throw new FinalExamError(409, "Este quiz ya tiene entregas. No se puede cambiar su ponderación ni convertirlo en examen final.");
      }
    }
    const course = courseSnap.data() ?? {};
    const configured = course.finalExam;
    if (kind === "final" && configured && (configured.classId !== classRef.id || configured.lessonId !== lessonId)) throw new FinalExamError(409, "La materia ya tiene un examen final. Edita ese examen para reemplazar su plantilla.");
    const lesson = lessonSnap.data() ?? {};
    const lessonNumber = Number(lesson.lessonNumber) || Number(text(lesson.title).match(/(?:semana|lecci[oó]n)\s*(\d+)/i)?.[1]) || (typeof lesson.order === "number" ? lesson.order + 1 : 0);
    if (kind === "final" && lessonNumber !== 5) throw new FinalExamError(400, "Agrega o marca el examen final dentro de la lección de la semana 5.");
    const weeklyLessons = await transaction.get(courseRef.collection("lessons"));
    let otherQuizPoints = 0;
    for (const week of weeklyLessons.docs) {
      const classes = await transaction.get(week.ref.collection("classes"));
      for (const activity of classes.docs) {
        if (activity.ref.path === classRef.path) continue;
        const activityData = activity.data();
        if (activityData.assessmentKind === "final" && kind === "final") throw new FinalExamError(409, "Ya existe otro examen final en la materia.");
        if (activityData.type === "quiz") {
          const quizQuestions = await transaction.get(activity.ref.collection("questions"));
          otherQuizPoints += quizQuestions.docs.reduce((sum, question) => sum + (typeof question.data().pointValue === "number" ? question.data().pointValue : 1), 0);
        }
        if (activityData.forumEnabled === true) otherQuizPoints += typeof activityData.forumPointValue === "number" ? activityData.forumPointValue : 5;
      }
    }
    if (kind === "final" && otherQuizPoints > 90.001) throw new FinalExamError(400, "Los quizzes y foros restantes superan 90 puntos. Ajusta sus puntajes antes de reservar los 10 puntos del examen final.");
    if (kind === "regular") {
      if (current.assessmentKind !== "final") throw new FinalExamError(400, "El quiz no está marcado como examen final.");
      transaction.update(classRef, { assessmentKind: "regular", assessmentVersion: (current.assessmentVersion ?? 0) + 1 });
      transaction.update(courseRef, { finalExam: FieldValue.delete() });
      return;
    }
    transaction.set(classRef, {
      ...current, id: classRef.id, title, type: "quiz", assessmentKind: "final", assessmentVersion: (current.assessmentVersion ?? 0) + 1,
      order: current.order ?? (typeof body.order === "number" ? body.order : 0), content: text(body.content),
      hasAssignment: false, forumEnabled: false, showInStudentPlatform: true, finalExamAttemptCount: 0,
      finalExamMaxPoints: FINAL_EXAM_POINTS, createdAt: current.createdAt ?? FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
    previousQuestions.docs.forEach((question) => transaction.delete(question.ref));
    questions!.forEach((question) => transaction.set(classRef.collection("questions").doc(question.id), { ...question, createdAt: FieldValue.serverTimestamp() }));
    transaction.set(courseRef, {
      finalExam: { classId: classRef.id, lessonId, maxPoints: 10, opensAtWeek: 5, otherActivitiesMaxPoints: 90 },
      ...(access.shouldBackfillMentor ? { mentorIds: Array.from(new Set([...access.mentorIds, user.uid])) } : {}),
    }, { merge: true });
  });
  return { classId: classRef.id, assessmentKind: kind };
}

function studentExamState(courseId: string, studentId: string, classData: Data, enrollment: Data, group: Data) {
  if (isStudentStatusBlocked(group.status)) throw new FinalExamError(403, "El grupo está inactivo.");
  if (enrollment.studentId !== studentId || enrollment.groupId === undefined || isStudentStatusBlocked(enrollment.status)) throw new FinalExamError(403, "Inscripción fuera de tu alcance o inactiva.");
  if (enrollment.studyOnly === true || enrollment.source === "globalExamStudy" || strings(enrollment.excludedCourseIds).includes(courseId)) throw new FinalExamError(403, "Esta materia no está disponible para evaluación.");
  const scoped = enrollment.isCourseOverride === true || enrollment.scope === "course" || ["courseOverride", "extraCourse"].includes(text(enrollment.source));
  if (scoped && ![...strings(enrollment.courseIds), text(enrollment.courseId)].includes(courseId)) throw new FinalExamError(403, "La materia no está asignada a tu inscripción.");
  const courses = Array.isArray(group.courses) && group.courses.length ? group.courses as Data[] : [{ courseId: group.courseId, enabledAt: group.courseEnabledAt }];
  const linked = courses.find((course) => course.courseId === courseId);
  if (!linked) throw new FinalExamError(403, "La materia no pertenece a tu grupo.");
  if (classData.assessmentKind !== "final") throw new FinalExamError(400, "Esta actividad no es un examen final.");
  const opensAt = finalExamOpensAt(linked.enabledAt ?? group.startDate ?? group.createdAt ?? enrollment.enrolledAt);
  const closures = enrollment.courseClosures as Record<string, Data> | undefined;
  const closed = closures?.[courseId]?.status === "closed";
  return { opensAt: opensAt?.toISOString() ?? null, available: Boolean(opensAt && Date.now() >= opensAt.getTime() && !closed), closed };
}

async function loadStudentExam(courseId: string, input: Data, user: Awaited<ReturnType<typeof finalExamUser>>, transaction?: Transaction) {
  if (user.role !== "student") throw new FinalExamError(403, "Este acceso corresponde al alumno.");
  const db = getAdminFirestore();
  const enrollmentId = finalExamId(input.enrollmentId);
  const lessonId = finalExamId(input.lessonId);
  const classId = finalExamId(input.classId);
  const classRef = db.collection("courses").doc(courseId).collection("lessons").doc(lessonId).collection("classes").doc(classId);
  const enrollmentRef = db.collection("studentEnrollments").doc(enrollmentId);
  const get = (reference: FirebaseFirestore.DocumentReference): Promise<DocumentSnapshot> => transaction ? transaction.get(reference) : reference.get();
  const [enrollmentSnap, classSnap] = await Promise.all([get(enrollmentRef), get(classRef)]);
  if (!enrollmentSnap.exists || !classSnap.exists) throw new FinalExamError(404, "No se encontró la inscripción o el examen.");
  const enrollment = enrollmentSnap.data()!;
  const groupId = finalExamId(enrollment.groupId);
  const groupRef = db.collection("groups").doc(groupId);
  const groupSnap = await get(groupRef);
  if (!groupSnap.exists) throw new FinalExamError(404, "No se encontró el grupo.");
  const state = studentExamState(courseId, user.uid, classSnap.data()!, enrollment, groupSnap.data()!);
  return { ...state, classRef, enrollmentRef, groupRef, classData: classSnap.data()!, enrollment, group: groupSnap.data()!, classId, lessonId, groupId };
}

export async function readFinalExam(courseId: string, input: Data, user: Awaited<ReturnType<typeof finalExamUser>>) {
  if (input.mode === "editor") {
    if (!STAFF_ROLES.includes(user.role)) throw new FinalExamError(403, "No tienes acceso al editor del examen.");
    const access = await resolveCourseManagementAccess({ courseId, uid: user.uid, role: user.role as CourseManagementRole, coordinatorPlantelIds: user.plantelIds, AccessError: FinalExamError });
    if (!access.allowed) throw new FinalExamError(403, "No tienes acceso a esta materia.");
    const classRef = getAdminFirestore().collection("courses").doc(courseId).collection("lessons").doc(finalExamId(input.lessonId)).collection("classes").doc(finalExamId(input.classId));
    const snapshot = await classRef.get();
    if (!snapshot.exists || snapshot.data()?.assessmentKind !== "final") throw new FinalExamError(404, "No se encontró el examen final.");
    const questions = await classRef.collection("questions").orderBy("order").get();
    return { questions: questions.docs.map((question) => ({ ...question.data(), id: question.id })) };
  }
  const exam = await loadStudentExam(courseId, input, user);
  const attempt = await exam.classRef.collection("finalExamAttempts").doc(`${exam.groupId}_${user.uid}`).get();
  const questions = exam.available && !attempt.exists ? await exam.classRef.collection("questions").orderBy("order").get() : null;
  return {
    opensAt: exam.opensAt, available: exam.available, closed: exam.closed, submitted: attempt.exists,
    grade: attempt.data()?.grade ?? null, maxPoints: 10,
    questions: questions?.docs.map((question) => {
      const data = question.data();
      return { id: question.id, prompt: data.prompt, text: data.prompt, pointValue: data.pointValue, order: data.order,
        options: (data.options as Data[]).map((option) => ({ id: option.id, text: option.text })) };
    }) ?? [],
  };
}

export async function submitFinalExam(courseId: string, input: Data, user: Awaited<ReturnType<typeof finalExamUser>>) {
  if (!input.answers || typeof input.answers !== "object" || Array.isArray(input.answers)) throw new FinalExamError(400, "Respuestas inválidas.");
  const answers = input.answers as Record<string, unknown>;
  return getAdminFirestore().runTransaction(async (transaction) => {
    const exam = await loadStudentExam(courseId, input, user, transaction);
    const attemptRef = exam.classRef.collection("finalExamAttempts").doc(`${exam.groupId}_${user.uid}`);
    const attempt = await transaction.get(attemptRef);
    if (attempt.exists) return { grade: attempt.data()!.grade as number, submitted: true };
    if (!exam.available) throw new FinalExamError(409, exam.closed ? "La materia ya está cerrada." : `El examen se habilita en semana 5${exam.opensAt ? `: ${exam.opensAt}` : ". Falta registrar la fecha de inicio de la materia."}`);
    const questions = await transaction.get(exam.classRef.collection("questions").orderBy("order"));
    if (questions.empty || Object.keys(answers).length !== questions.size) throw new FinalExamError(400, "Responde todas las preguntas del examen.");
    let earned = 0;
    let maximum = 0;
    const detailedAnswers = questions.docs.map((question) => {
      const data = question.data() as FinalExamQuestion;
      const selected = data.options.find((option) => option.id === answers[question.id]);
      if (!selected) throw new FinalExamError(400, "Hay respuestas que no corresponden a las preguntas del examen.");
      maximum += data.pointValue;
      if (selected.isCorrect) earned += data.pointValue;
      return { questionId: question.id, question: data.prompt, questionPointValue: data.pointValue, selectedOptionId: selected.id, selectedOptionText: selected.text };
    });
    if (Math.abs(maximum - 10) > 0.001) throw new FinalExamError(409, "La configuración del examen no suma 10 puntos. Contacta al mentor.");
    const grade = Math.round(earned * 10) / 10;
    const progressId = `${exam.groupId}_${courseId}_${exam.classId}`;
    const now = FieldValue.serverTimestamp();
    const submission = {
      classId: exam.classId, classDocId: exam.classId, className: exam.classData.title, classType: "quiz", assessmentKind: "final",
      courseId, courseTitle: text(input.courseTitle), lessonId: exam.lessonId, lessonTitle: text(input.lessonTitle),
      studentId: user.uid, studentName: user.name, enrollmentId: exam.enrollmentRef.id, groupId: exam.groupId,
      answers: detailedAnswers, grade, status: "graded", submittedAt: now, gradedAt: now, content: "Examen final calificado automáticamente sobre 10 puntos.",
    };
    transaction.create(attemptRef, { ...submission, answersByQuestion: answers });
    transaction.set(exam.groupRef.collection("submissions").doc(`final-${exam.classId}-${user.uid}`), submission);
    transaction.set(exam.enrollmentRef.collection("classProgress").doc(progressId), {
      courseId, lessonId: exam.lessonId, classDocId: exam.classId, assessmentKind: "final", quizCompleted: true,
      completed: true, progress: 100, quizAnswers: answers, quizAnswersDetailed: detailedAnswers, grade, status: "graded", lastUpdated: now,
    }, { merge: true });
    transaction.update(exam.classRef, { finalExamAttemptCount: FieldValue.increment(1) });
    return { grade, submitted: true };
  });
}
