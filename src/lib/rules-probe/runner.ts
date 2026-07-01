import { getApps, initializeApp } from "firebase/app";
import { getAuth, signInWithCustomToken, signOut, type Auth } from "firebase/auth";
import {
  deleteDoc,
  doc,
  getDoc,
  getFirestore,
  setDoc,
  updateDoc,
  type Firestore,
} from "firebase/firestore";
import {
  PROBE_CLASS,
  PROBE_CLASS_CREATE,
  PROBE_CLASSEVAL_CREATE,
  PROBE_COURSE,
  PROBE_COURSE_CREATE,
  PROBE_ENROLLMENT,
  PROBE_FORUM_CREATE,
  PROBE_FORUM_DELETE,
  PROBE_FORUM_POST,
  PROBE_GRADE_DOC,
  PROBE_GROUP,
  PROBE_GROUP_CREATE,
  PROBE_GROUPSTUDENT_CREATE,
  PROBE_IDS,
  PROBE_LESSON,
  PROBE_LESSON_CREATE,
  PROBE_PLANTEL,
  PROBE_PLANTEL_CREATE,
  PROBE_QUESTION_CREATE,
  PROBE_REPLY_CREATE,
  PROBE_ROLE_ORDER,
  PROBE_SOLICITUD_CREATE,
  PROBE_STUDENT_DOC,
  PROBE_SUB_CREATE_OTHER,
  PROBE_SUB_CREATE_QUIZ,
  PROBE_SUB_CREATE_SELF,
  PROBE_SUB_CREATE_TEACHER,
  PROBE_SUB_DELETE,
  PROBE_SUB_GRADED,
  PROBE_SUB_OTHER,
  PROBE_SUB_UNGRADED,
  PROBE_SURVEY,
  PROBE_SURVEY_CREATE,
  PROBE_SURVEYRESP_CREATE,
  PROBE_TEACHEREVAL_CREATE,
  type ProbeRole,
} from "./constants";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

const PROBE_APP_NAME = "RULES_PROBE";

function getProbeApp() {
  return getApps().find((a) => a.name === PROBE_APP_NAME) ?? initializeApp(firebaseConfig, PROBE_APP_NAME);
}

export type ProbeOutcome = "allow" | "deny" | "error";

export type ProbeCaseResult = {
  id: string;
  label: string;
  role: ProbeRole;
  expected: "allow" | "deny";
  actual: ProbeOutcome;
  pass: boolean;
  errorMessage?: string;
};

type ProbeCase = {
  id: string;
  label: string;
  role: ProbeRole;
  expected: "allow" | "deny";
  run: (probeDb: Firestore) => Promise<void>;
};

const subRef = (db: Firestore, id: string) =>
  doc(db, "groups", PROBE_GROUP, "submissions", id);
const gradesRef = (db: Firestore, id: string) => doc(db, "groups", PROBE_GROUP, "grades", id);
const groupStudentRef = (db: Firestore, id: string) =>
  doc(db, "groups", PROBE_GROUP, "students", id);
const CLASS_PATH = ["courses", PROBE_COURSE, "lessons", PROBE_LESSON, "classes", PROBE_CLASS] as const;
const forumRef = (db: Firestore, id: string) => doc(db, ...CLASS_PATH, "forums", id);
const replyRef = (db: Firestore, postId: string, id: string) =>
  doc(db, ...CLASS_PATH, "forums", postId, "replies", id);

const PROBE_CASES: ProbeCase[] = [
  // ===================== ALUMNO =====================
  {
    id: "student-create-submission-tarea",
    label: "Enviar entrega (tarea, sin courseId)",
    role: "student",
    expected: "allow",
    run: (db) =>
      setDoc(subRef(db, PROBE_SUB_CREATE_SELF), {
        studentId: PROBE_IDS.student,
        classId: PROBE_CLASS,
        status: "pending",
        content: "probe",
      }),
  },
  {
    id: "student-create-submission-quiz",
    label: "Enviar quiz (con courseId)",
    role: "student",
    expected: "allow",
    run: (db) =>
      setDoc(subRef(db, PROBE_SUB_CREATE_QUIZ), {
        studentId: PROBE_IDS.student,
        courseId: PROBE_COURSE,
        classId: PROBE_CLASS,
        classType: "quiz",
        status: "pending",
      }),
  },
  {
    id: "student-create-forum-post",
    label: "Publicar en foro (autor = él)",
    role: "student",
    expected: "allow",
    run: (db) => setDoc(forumRef(db, PROBE_FORUM_CREATE), { authorId: PROBE_IDS.student, content: "probe" }),
  },
  {
    id: "student-create-forum-reply",
    label: "Responder en un hilo de foro",
    role: "student",
    expected: "allow",
    run: (db) =>
      setDoc(replyRef(db, PROBE_FORUM_POST, PROBE_REPLY_CREATE), {
        authorId: PROBE_IDS.student,
        content: "probe-reply",
      }),
  },
  {
    id: "student-update-own-ungraded",
    label: "Editar su entrega NO calificada",
    role: "student",
    expected: "allow",
    run: (db) => updateDoc(subRef(db, PROBE_SUB_UNGRADED), { content: "probe-edit" }),
  },
  {
    id: "student-update-graded",
    label: "Editar su entrega YA calificada (debe bloquearse)",
    role: "student",
    expected: "deny",
    run: (db) => updateDoc(subRef(db, PROBE_SUB_GRADED), { content: "probe-edit" }),
  },
  {
    id: "student-read-other-submission",
    label: "Leer la entrega de otro alumno (debe bloquearse)",
    role: "student",
    expected: "deny",
    run: async (db) => {
      await getDoc(subRef(db, PROBE_SUB_OTHER));
    },
  },
  {
    id: "student-create-submission-as-other",
    label: "Crear entrega a nombre de otro alumno (debe bloquearse)",
    role: "student",
    expected: "deny",
    run: (db) =>
      setDoc(subRef(db, PROBE_SUB_CREATE_OTHER), {
        studentId: PROBE_IDS.otherStudent,
        classId: PROBE_CLASS,
        status: "pending",
      }),
  },
  {
    id: "student-write-grades",
    label: "Escribir en calificaciones del grupo (debe bloquearse)",
    role: "student",
    expected: "deny",
    run: (db) => setDoc(gradesRef(db, PROBE_GRADE_DOC), { value: 10 }),
  },
  {
    id: "student-write-own-progress",
    label: "Guardar su progreso de clase (classProgress)",
    role: "student",
    expected: "allow",
    run: (db) =>
      setDoc(
        doc(db, "studentEnrollments", PROBE_ENROLLMENT, "classProgress", PROBE_CLASS),
        { seen: true },
      ),
  },
  {
    id: "student-read-own-enrollment",
    label: "Leer su propia inscripción",
    role: "student",
    expected: "allow",
    run: async (db) => {
      await getDoc(doc(db, "studentEnrollments", PROBE_ENROLLMENT));
    },
  },
  {
    id: "student-create-class-evaluation",
    label: "Evaluar la clase (rating)",
    role: "student",
    expected: "allow",
    run: (db) =>
      setDoc(doc(db, "classEvaluations", PROBE_CLASSEVAL_CREATE), {
        studentId: PROBE_IDS.student,
        classDocId: PROBE_CLASS,
        rating: 5,
      }),
  },
  {
    id: "student-create-teacher-evaluation",
    label: "Evaluar al profesor (rating)",
    role: "student",
    expected: "allow",
    run: (db) =>
      setDoc(doc(db, "teacherEvaluations", PROBE_TEACHEREVAL_CREATE), {
        studentId: PROBE_IDS.student,
        teacherId: PROBE_IDS.teacherGroup,
        classDocId: PROBE_CLASS,
        groupId: PROBE_GROUP,
        rating: 5,
      }),
  },
  {
    id: "student-read-published-survey",
    label: "Ver una encuesta publicada",
    role: "student",
    expected: "allow",
    run: async (db) => {
      await getDoc(doc(db, "satisfactionSurveys", PROBE_SURVEY));
    },
  },
  {
    id: "student-create-survey-response",
    label: "Responder una encuesta publicada",
    role: "student",
    expected: "allow",
    run: (db) =>
      setDoc(doc(db, "surveyResponses", PROBE_SURVEYRESP_CREATE), {
        studentId: PROBE_IDS.student,
        surveyId: PROBE_SURVEY,
        answers: [{ q: "1", a: "ok" }],
      }),
  },
  {
    id: "student-create-solicitud-certificado",
    label: "Solicitar certificado",
    role: "student",
    expected: "allow",
    run: (db) =>
      setDoc(doc(db, "solicitudesCertificado", PROBE_SOLICITUD_CREATE), {
        userId: PROBE_IDS.student,
        tipo: "probe",
      }),
  },
  {
    id: "student-read-other-user",
    label: "Leer la cuenta de otro usuario (debe bloquearse)",
    role: "student",
    expected: "deny",
    run: async (db) => {
      await getDoc(doc(db, "users", PROBE_IDS.otherStudent));
    },
  },

  // ===================== PROFESOR DEL GRUPO =====================
  {
    id: "teacherGroup-grade-submission",
    label: "Calificar entrega del grupo",
    role: "teacherGroup",
    expected: "allow",
    run: (db) => updateDoc(subRef(db, PROBE_SUB_UNGRADED), { grade: 8, status: "graded" }),
  },
  {
    id: "teacherGroup-write-grades",
    label: "Cerrar/escribir calificaciones del grupo",
    role: "teacherGroup",
    expected: "allow",
    run: (db) => setDoc(gradesRef(db, PROBE_GRADE_DOC), { value: 9 }),
  },
  {
    id: "teacherGroup-read-submission",
    label: "Leer entregas de sus alumnos",
    role: "teacherGroup",
    expected: "allow",
    run: async (db) => {
      await getDoc(subRef(db, PROBE_SUB_OTHER));
    },
  },
  {
    id: "teacherGroup-read-students",
    label: "Leer alumnos del grupo",
    role: "teacherGroup",
    expected: "allow",
    run: async (db) => {
      await getDoc(groupStudentRef(db, PROBE_STUDENT_DOC));
    },
  },
  {
    id: "teacherGroup-create-student",
    label: "Agregar alumno al grupo",
    role: "teacherGroup",
    expected: "allow",
    run: (db) =>
      setDoc(groupStudentRef(db, PROBE_GROUPSTUDENT_CREATE), {
        studentId: PROBE_IDS.student,
        studentName: "Probe",
      }),
  },
  {
    id: "teacherGroup-delete-submission",
    label: "Eliminar una entrega del grupo",
    role: "teacherGroup",
    expected: "allow",
    run: (db) => deleteDoc(subRef(db, PROBE_SUB_DELETE)),
  },

  // ============ PROFESOR TITULAR DE LA MATERIA (no es el del grupo) ============
  {
    id: "teacherCourse-grade-submission",
    label: "Calificar entrega de SU materia (multi-materia)",
    role: "teacherCourse",
    expected: "allow",
    run: (db) => updateDoc(subRef(db, PROBE_SUB_UNGRADED), { grade: 7, status: "graded" }),
  },
  {
    id: "teacherCourse-create-manual-submission",
    label: "Crear entrega manual en SU materia",
    role: "teacherCourse",
    expected: "allow",
    run: (db) =>
      setDoc(subRef(db, PROBE_SUB_CREATE_TEACHER), {
        studentId: PROBE_IDS.student,
        courseId: PROBE_COURSE,
        classId: PROBE_CLASS,
        status: "graded",
        grade: 6,
      }),
  },
  {
    id: "teacherCourse-create-lesson",
    label: "Crear lección en su materia",
    role: "teacherCourse",
    expected: "allow",
    run: (db) =>
      setDoc(doc(db, "courses", PROBE_COURSE, "lessons", PROBE_LESSON_CREATE), {
        title: "Probe Lección 2",
        order: 1,
      }),
  },
  {
    id: "teacherCourse-create-class",
    label: "Crear clase en su materia",
    role: "teacherCourse",
    expected: "allow",
    run: (db) =>
      setDoc(doc(db, "courses", PROBE_COURSE, "lessons", PROBE_LESSON, "classes", PROBE_CLASS_CREATE), {
        title: "Probe Clase 2",
        order: 1,
      }),
  },
  {
    id: "teacherCourse-create-question",
    label: "Crear pregunta en una clase",
    role: "teacherCourse",
    expected: "allow",
    run: (db) =>
      setDoc(doc(db, ...CLASS_PATH, "questions", PROBE_QUESTION_CREATE), { prompt: "probe" }),
  },
  {
    id: "teacherCourse-grade-forum",
    label: "Calificar una aportación de foro",
    role: "teacherCourse",
    expected: "allow",
    run: (db) => updateDoc(forumRef(db, PROBE_FORUM_POST), { grade: 5, status: "graded" }),
  },
  {
    id: "teacherCourse-delete-forum",
    label: "Eliminar una aportación de foro",
    role: "teacherCourse",
    expected: "allow",
    run: (db) => deleteDoc(forumRef(db, PROBE_FORUM_DELETE)),
  },

  // ===================== COORDINADOR DE PLANTEL =====================
  {
    id: "coordinator-read-enrollment",
    label: "Leer inscripción de alumno de su plantel",
    role: "coordinator",
    expected: "allow",
    run: async (db) => {
      await getDoc(doc(db, "studentEnrollments", PROBE_ENROLLMENT));
    },
  },
  {
    id: "coordinator-read-group-students",
    label: "Leer alumnos de un grupo de su plantel",
    role: "coordinator",
    expected: "allow",
    run: async (db) => {
      await getDoc(groupStudentRef(db, PROBE_STUDENT_DOC));
    },
  },
  {
    id: "coordinator-read-submission",
    label: "Leer entregas de un grupo de su plantel",
    role: "coordinator",
    expected: "allow",
    run: async (db) => {
      await getDoc(subRef(db, PROBE_SUB_OTHER));
    },
  },
  {
    id: "coordinator-read-grades",
    label: "Leer calificaciones de un grupo de su plantel",
    role: "coordinator",
    expected: "allow",
    run: async (db) => {
      await getDoc(gradesRef(db, PROBE_GRADE_DOC));
    },
  },
  {
    id: "coordinator-mark-dropout-risk",
    label: "Marcar riesgo de deserción a un alumno de su plantel",
    role: "coordinator",
    expected: "allow",
    run: (db) =>
      updateDoc(doc(db, "users", PROBE_IDS.student), {
        dropoutRiskTag: "alto",
        dropoutRiskTaggedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
  },
  {
    id: "coordinator-read-student-user",
    label: "Leer la cuenta de un alumno de su plantel",
    role: "coordinator",
    expected: "allow",
    run: async (db) => {
      await getDoc(doc(db, "users", PROBE_IDS.student));
    },
  },
  {
    id: "coordinator-grade-submission",
    label: "Calificar entrega (debe bloquearse: no es su materia/grupo)",
    role: "coordinator",
    expected: "deny",
    run: (db) => updateDoc(subRef(db, PROBE_SUB_GRADED), { grade: 1 }),
  },

  // ===================== ADMINTEACHER =====================
  {
    id: "adminTeacher-create-course",
    label: "Crear materia",
    role: "adminTeacher",
    expected: "allow",
    run: (db) =>
      setDoc(doc(db, "courses", PROBE_COURSE_CREATE), {
        title: "Probe",
        teacherId: PROBE_IDS.adminTeacher,
        isProbe: true,
      }),
  },
  {
    id: "adminTeacher-create-group",
    label: "Crear grupo",
    role: "adminTeacher",
    expected: "allow",
    run: (db) =>
      setDoc(doc(db, "groups", PROBE_GROUP_CREATE), {
        groupName: "Probe",
        teacherId: PROBE_IDS.adminTeacher,
        plantelId: PROBE_PLANTEL,
        isProbe: true,
      }),
  },
  {
    id: "adminTeacher-create-plantel",
    label: "Crear plantel",
    role: "adminTeacher",
    expected: "allow",
    run: (db) => setDoc(doc(db, "planteles", PROBE_PLANTEL_CREATE), { name: "Probe", isProbe: true }),
  },
  {
    id: "adminTeacher-create-survey",
    label: "Crear encuesta",
    role: "adminTeacher",
    expected: "allow",
    run: (db) =>
      setDoc(doc(db, "satisfactionSurveys", PROBE_SURVEY_CREATE), {
        title: "Probe",
        status: "draft",
        isProbe: true,
      }),
  },
  {
    id: "adminTeacher-update-student-user",
    label: "Editar la cuenta de un alumno",
    role: "adminTeacher",
    expected: "allow",
    run: (db) => updateDoc(doc(db, "users", PROBE_IDS.student), { name: "Probe Alumno (edit)" }),
  },

  // ===================== MENTOR DE MATERIA =====================
  {
    id: "mentor-adjust-lessons-count",
    label: "Ajustar contador de lecciones de su materia",
    role: "mentor",
    expected: "allow",
    run: (db) => updateDoc(doc(db, "courses", PROBE_COURSE), { lessonsCount: 2 }),
  },
  {
    id: "mentor-grade-forum",
    label: "Calificar aportación de foro de su materia",
    role: "mentor",
    expected: "allow",
    run: (db) => updateDoc(forumRef(db, PROBE_FORUM_POST), { grade: 4, status: "graded" }),
  },
  {
    id: "mentor-grade-submission",
    label: "Calificar entrega de su materia",
    role: "mentor",
    expected: "allow",
    run: (db) => updateDoc(subRef(db, PROBE_SUB_UNGRADED), { grade: 9, status: "graded" }),
  },
];

function classifyError(error: unknown): { outcome: ProbeOutcome; message?: string } {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "permission-denied"
  ) {
    return { outcome: "deny" };
  }
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "Error desconocido";
  return { outcome: "error", message };
}

export async function runRulesProbe(tokens: Record<string, string>): Promise<ProbeCaseResult[]> {
  const probeApp = getProbeApp();
  const probeAuth: Auth = getAuth(probeApp);
  const probeDb = getFirestore(probeApp);
  const results: ProbeCaseResult[] = [];

  try {
    for (const role of PROBE_ROLE_ORDER) {
      const token = tokens[role];
      const roleCases = PROBE_CASES.filter((c) => c.role === role);
      if (!token || roleCases.length === 0) continue;

      await signInWithCustomToken(probeAuth, token);

      for (const probeCase of roleCases) {
        let actual: ProbeOutcome;
        let errorMessage: string | undefined;
        try {
          await probeCase.run(probeDb);
          actual = "allow";
        } catch (error) {
          const classified = classifyError(error);
          actual = classified.outcome;
          errorMessage = classified.message;
        }
        results.push({
          id: probeCase.id,
          label: probeCase.label,
          role: probeCase.role,
          expected: probeCase.expected,
          actual,
          pass: actual === probeCase.expected,
          errorMessage,
        });
      }
    }
  } finally {
    await signOut(probeAuth).catch(() => undefined);
  }

  return results;
}
