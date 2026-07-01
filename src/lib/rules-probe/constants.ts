// Sandbox aislado para el panel de diagnóstico de permisos (rules-probe).
// Todos los ids usan el prefijo __rulesProbe__ para poder ocultarlos de las
// vistas normales (Grupos/Cursos/Alumnos) y limpiarlos sin tocar datos reales.
// IMPORTANTE: estos documentos viven en colecciones REALES a propósito, para que
// las reglas de seguridad reales (con sus get()/exists()) se evalúen de verdad.

export const PROBE_PREFIX = "__rulesProbe__";

export const isProbeId = (value: unknown): boolean =>
  typeof value === "string" && value.startsWith(PROBE_PREFIX);

// Identidades de prueba (no son usuarios persistentes; se usan custom tokens efímeros).
export const PROBE_IDS = {
  student: `${PROBE_PREFIX}student`,
  otherStudent: `${PROBE_PREFIX}otherStudent`,
  teacherGroup: `${PROBE_PREFIX}teacherGroup`,
  teacherCourse: `${PROBE_PREFIX}teacherCourse`,
  coordinator: `${PROBE_PREFIX}coordinator`,
  adminTeacher: `${PROBE_PREFIX}adminTeacher`,
  mentor: `${PROBE_PREFIX}mentor`,
} as const;

// Documentos base del sandbox.
export const PROBE_PLANTEL = `${PROBE_PREFIX}plantel`;
export const PROBE_GROUP = `${PROBE_PREFIX}group`;
export const PROBE_COURSE = `${PROBE_PREFIX}course`;
export const PROBE_LESSON = `${PROBE_PREFIX}lesson`;
export const PROBE_CLASS = `${PROBE_PREFIX}class`;
export const PROBE_ENROLLMENT = `${PROBE_GROUP}_${PROBE_IDS.student}`;

// Entregas sembradas (existentes).
export const PROBE_SUB_UNGRADED = `${PROBE_PREFIX}subUngraded`;
export const PROBE_SUB_GRADED = `${PROBE_PREFIX}subGraded`;
export const PROBE_SUB_OTHER = `${PROBE_PREFIX}subOther`;
export const PROBE_SUB_DELETE = `${PROBE_PREFIX}subDelete`;

// Otros documentos sembrados (existentes) que las pruebas leen/actualizan.
export const PROBE_STUDENT_DOC = `${PROBE_PREFIX}studentDoc`; // groups/{g}/students/{id}
export const PROBE_GRADE_DOC = PROBE_IDS.student; // groups/{g}/grades/{studentId}
export const PROBE_FORUM_POST = `${PROBE_PREFIX}forumPost`; // post sembrado (autor: otherStudent)
export const PROBE_FORUM_DELETE = `${PROBE_PREFIX}forumDelete`; // post sembrado para borrar
export const PROBE_SURVEY = `${PROBE_PREFIX}survey`; // satisfactionSurveys publicado

// Documentos transitorios: el seed los BORRA en cada corrida para que las pruebas
// de "create" evalúen realmente la regla de creación (no de update).
export const PROBE_SUB_CREATE_SELF = `${PROBE_PREFIX}subCreateSelf`;
export const PROBE_SUB_CREATE_QUIZ = `${PROBE_PREFIX}subCreateQuiz`;
export const PROBE_SUB_CREATE_OTHER = `${PROBE_PREFIX}subCreateOther`;
export const PROBE_SUB_CREATE_TEACHER = `${PROBE_PREFIX}subCreateTeacher`;
export const PROBE_FORUM_CREATE = `${PROBE_PREFIX}forumCreate`;
export const PROBE_REPLY_CREATE = `${PROBE_PREFIX}replyCreate`;
export const PROBE_CLASSEVAL_CREATE = `${PROBE_PREFIX}classEvalCreate`;
export const PROBE_TEACHEREVAL_CREATE = `${PROBE_PREFIX}teacherEvalCreate`;
export const PROBE_SURVEYRESP_CREATE = `${PROBE_SURVEY}_${PROBE_IDS.student}`; // respuesta del alumno
export const PROBE_GROUPSTUDENT_CREATE = `${PROBE_PREFIX}groupStudentCreate`;
export const PROBE_LESSON_CREATE = `${PROBE_PREFIX}lessonCreate`;
export const PROBE_CLASS_CREATE = `${PROBE_PREFIX}classCreate`;
export const PROBE_QUESTION_CREATE = `${PROBE_PREFIX}questionCreate`;
export const PROBE_COURSE_CREATE = `${PROBE_PREFIX}courseCreate`;
export const PROBE_GROUP_CREATE = `${PROBE_PREFIX}groupCreate`;
export const PROBE_PLANTEL_CREATE = `${PROBE_PREFIX}plantelCreate`;
export const PROBE_SURVEY_CREATE = `${PROBE_PREFIX}surveyCreate`;
export const PROBE_SOLICITUD_CREATE = `${PROBE_PREFIX}solicitudCreate`;

export type ProbeRole =
  | "student"
  | "teacherGroup"
  | "teacherCourse"
  | "coordinator"
  | "adminTeacher"
  | "mentor";

export const PROBE_ROLE_ORDER: ProbeRole[] = [
  "student",
  "teacherGroup",
  "teacherCourse",
  "coordinator",
  "adminTeacher",
  "mentor",
];

export const PROBE_ROLE_LABELS: Record<ProbeRole, string> = {
  student: "Alumno",
  teacherGroup: "Profesor (del grupo)",
  teacherCourse: "Profesor (titular de la materia)",
  coordinator: "Coordinador de plantel",
  adminTeacher: "AdminTeacher",
  mentor: "Mentor de materia",
};

// El rol que se emite en el claim del custom token de cada identidad.
export const PROBE_TOKEN_ROLE: Record<ProbeRole, string> = {
  student: "student",
  teacherGroup: "teacher",
  teacherCourse: "teacher",
  coordinator: "coordinadorPlantel",
  adminTeacher: "adminTeacher",
  mentor: "teacher",
};
