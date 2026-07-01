import { NextRequest, NextResponse } from "next/server";
import { getAdminApp, getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";
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
  PROBE_TOKEN_ROLE,
  PROBE_ROLE_ORDER,
} from "@/lib/rules-probe/constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADMIN_ROLES = new Set(["adminTeacher", "superAdminTeacher", "admin", "superAdmin"]);

function extractBearer(header: string | null): string | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
  return trimmed.slice(7).trim() || null;
}

async function requireAdmin(request: NextRequest): Promise<void> {
  const token = extractBearer(request.headers.get("authorization"));
  if (!token) {
    throw new Response("Authorization Bearer requerido", { status: 401 });
  }
  const decoded = await getAdminAuth().verifyIdToken(token);
  const userSnap = await getAdminFirestore().collection("users").doc(decoded.uid).get();
  const role =
    (typeof userSnap.data()?.role === "string" ? (userSnap.data()?.role as string) : "") ||
    (typeof decoded.role === "string" ? decoded.role : "");
  if (!ADMIN_ROLES.has(role)) {
    throw new Response("Acceso restringido a AdminTeacher", { status: 403 });
  }
}

async function seedSandbox(): Promise<void> {
  const db = getAdminFirestore();
  const batch = db.batch();

  // ===== Identidades (users/{uid}) con su `role` en el doc, como un usuario real. =====
  batch.set(db.collection("users").doc(PROBE_IDS.student), {
    role: "student",
    name: "Probe Alumno",
    plantelIds: [PROBE_PLANTEL],
    approved: true,
    estado: "active",
    isProbe: true,
  });
  batch.set(db.collection("users").doc(PROBE_IDS.otherStudent), {
    role: "student",
    name: "Probe Otro Alumno",
    plantelIds: [PROBE_PLANTEL],
    approved: true,
    estado: "active",
    isProbe: true,
  });
  batch.set(db.collection("users").doc(PROBE_IDS.teacherGroup), {
    role: "teacher",
    name: "Probe Profesor Grupo",
    isProbe: true,
  });
  batch.set(db.collection("users").doc(PROBE_IDS.teacherCourse), {
    role: "teacher",
    name: "Probe Profesor Materia",
    isProbe: true,
  });
  batch.set(db.collection("users").doc(PROBE_IDS.coordinator), {
    role: "coordinadorPlantel",
    name: "Probe Coordinador",
    plantelIds: [PROBE_PLANTEL],
    isProbe: true,
  });
  batch.set(db.collection("users").doc(PROBE_IDS.adminTeacher), {
    role: "adminTeacher",
    name: "Probe AdminTeacher",
    isProbe: true,
  });
  batch.set(db.collection("users").doc(PROBE_IDS.mentor), {
    role: "teacher",
    name: "Probe Mentor",
    isProbe: true,
  });

  // ===== Plantel / Grupo / Curso =====
  batch.set(db.collection("planteles").doc(PROBE_PLANTEL), {
    name: "🔧 SANDBOX PERMISOS",
    isProbe: true,
  });

  batch.set(db.collection("groups").doc(PROBE_GROUP), {
    groupName: "🔧 SANDBOX PERMISOS (no usar)",
    teacherId: PROBE_IDS.teacherGroup,
    assistantTeacherIds: [],
    plantelId: PROBE_PLANTEL,
    isInPerson: true,
    status: "active",
    courses: [{ courseId: PROBE_COURSE, courseName: "Probe Materia" }],
    courseIds: [PROBE_COURSE],
    isProbe: true,
  });

  // Curso: titular = teacherCourse (distinto del titular del grupo). Mentor en mentorIds.
  const courseRef = db.collection("courses").doc(PROBE_COURSE);
  batch.set(courseRef, {
    title: "🔧 SANDBOX PERMISOS",
    teacherId: PROBE_IDS.teacherCourse,
    mentorIds: [PROBE_IDS.mentor],
    lessonsCount: 1,
    isProbe: true,
  });
  const lessonRef = courseRef.collection("lessons").doc(PROBE_LESSON);
  batch.set(lessonRef, { title: "Probe Lección", order: 0, isProbe: true });
  const classRef = lessonRef.collection("classes").doc(PROBE_CLASS);
  batch.set(classRef, { title: "Probe Clase", order: 0, type: "forum", isProbe: true });

  // Posts de foro sembrados (autor: otherStudent) para pruebas de calificar/borrar.
  batch.set(classRef.collection("forums").doc(PROBE_FORUM_POST), {
    authorId: PROBE_IDS.otherStudent,
    content: "probe-post",
    status: "pending",
    isProbe: true,
  });
  batch.set(classRef.collection("forums").doc(PROBE_FORUM_DELETE), {
    authorId: PROBE_IDS.otherStudent,
    content: "probe-post-delete",
    status: "pending",
    isProbe: true,
  });

  // ===== Inscripción del alumno =====
  batch.set(db.collection("studentEnrollments").doc(PROBE_ENROLLMENT), {
    studentId: PROBE_IDS.student,
    groupId: PROBE_GROUP,
    plantelId: PROBE_PLANTEL,
    courseClosures: {},
    isProbe: true,
  });

  // ===== Doc de alumno dentro del grupo (students/{id}) =====
  batch.set(db.collection("groups").doc(PROBE_GROUP).collection("students").doc(PROBE_STUDENT_DOC), {
    studentId: PROBE_IDS.student,
    studentName: "Probe Alumno",
    isProbe: true,
  });

  // ===== Calificaciones sembradas (grades/{studentId}) =====
  batch.set(db.collection("groups").doc(PROBE_GROUP).collection("grades").doc(PROBE_GRADE_DOC), {
    value: 100,
    isProbe: true,
  });

  // ===== Entregas sembradas =====
  const subs = db.collection("groups").doc(PROBE_GROUP).collection("submissions");
  batch.set(subs.doc(PROBE_SUB_UNGRADED), {
    studentId: PROBE_IDS.student,
    courseId: PROBE_COURSE,
    classId: PROBE_CLASS,
    status: "pending",
    isProbe: true,
  });
  batch.set(subs.doc(PROBE_SUB_GRADED), {
    studentId: PROBE_IDS.student,
    courseId: PROBE_COURSE,
    classId: PROBE_CLASS,
    status: "graded",
    grade: 10,
    isProbe: true,
  });
  batch.set(subs.doc(PROBE_SUB_OTHER), {
    studentId: PROBE_IDS.otherStudent,
    courseId: PROBE_COURSE,
    classId: PROBE_CLASS,
    status: "pending",
    isProbe: true,
  });
  batch.set(subs.doc(PROBE_SUB_DELETE), {
    studentId: PROBE_IDS.student,
    courseId: PROBE_COURSE,
    classId: PROBE_CLASS,
    status: "pending",
    isProbe: true,
  });

  // ===== Encuesta publicada (para lectura/respuesta del alumno) =====
  batch.set(db.collection("satisfactionSurveys").doc(PROBE_SURVEY), {
    title: "Probe Encuesta",
    status: "published",
    isProbe: true,
  });

  // ===== Borrar documentos transitorios (para que las pruebas de "create" sean limpias) =====
  const transientDeletes: FirebaseFirestore.DocumentReference[] = [
    subs.doc(PROBE_SUB_CREATE_SELF),
    subs.doc(PROBE_SUB_CREATE_QUIZ),
    subs.doc(PROBE_SUB_CREATE_OTHER),
    subs.doc(PROBE_SUB_CREATE_TEACHER),
    classRef.collection("forums").doc(PROBE_FORUM_CREATE),
    classRef.collection("forums").doc(PROBE_FORUM_POST).collection("replies").doc(PROBE_REPLY_CREATE),
    classRef.collection("questions").doc(PROBE_QUESTION_CREATE),
    db.collection("studentEnrollments").doc(PROBE_ENROLLMENT).collection("classProgress").doc(PROBE_CLASS),
    db.collection("classEvaluations").doc(PROBE_CLASSEVAL_CREATE),
    db.collection("teacherEvaluations").doc(PROBE_TEACHEREVAL_CREATE),
    db.collection("surveyResponses").doc(PROBE_SURVEYRESP_CREATE),
    db.collection("solicitudesCertificado").doc(PROBE_SOLICITUD_CREATE),
    db.collection("groups").doc(PROBE_GROUP).collection("students").doc(PROBE_GROUPSTUDENT_CREATE),
    courseRef.collection("lessons").doc(PROBE_LESSON_CREATE),
    lessonRef.collection("classes").doc(PROBE_CLASS_CREATE),
    db.collection("courses").doc(PROBE_COURSE_CREATE),
    db.collection("groups").doc(PROBE_GROUP_CREATE),
    db.collection("planteles").doc(PROBE_PLANTEL_CREATE),
    db.collection("satisfactionSurveys").doc(PROBE_SURVEY_CREATE),
  ];
  transientDeletes.forEach((ref) => batch.delete(ref));

  await batch.commit();
}

async function mintTokens(): Promise<Record<string, string>> {
  const auth = getAdminAuth();
  const entries = await Promise.all(
    PROBE_ROLE_ORDER.map(async (role) => {
      const uid = PROBE_IDS[role as keyof typeof PROBE_IDS];
      const token = await auth.createCustomToken(uid, { role: PROBE_TOKEN_ROLE[role], probe: true });
      return [role, token] as const;
    }),
  );
  return Object.fromEntries(entries);
}

async function fetchRulesVersion(): Promise<string | null> {
  try {
    const projectId =
      process.env.FIREBASE_ADMIN_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "";
    if (!projectId) return null;
    const credential = getAdminApp().options.credential;
    const accessToken = (await credential?.getAccessToken())?.access_token;
    if (!accessToken) return null;
    const res = await fetch(
      `https://firebaserules.googleapis.com/v1/projects/${projectId}/releases/cloud.firestore`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { rulesetName?: string; updateTime?: string };
    const rulesetId = data.rulesetName?.split("/").pop() ?? null;
    return rulesetId ? `${rulesetId}${data.updateTime ? ` · ${data.updateTime}` : ""}` : null;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireAdmin(request);
    await seedSandbox();
    const [tokens, rulesVersion] = await Promise.all([mintTokens(), fetchRulesVersion()]);
    return NextResponse.json({
      success: true,
      data: { tokens, rulesVersion, generatedAt: new Date().toISOString() },
    });
  } catch (error) {
    if (error instanceof Response) {
      return NextResponse.json({ success: false, error: await error.text() }, { status: error.status });
    }
    console.error("rules-probe seed error", error);
    return NextResponse.json(
      { success: false, error: "No se pudo preparar el sandbox de permisos" },
      { status: 500 },
    );
  }
}

// Limpieza del sandbox.
export async function DELETE(request: NextRequest) {
  try {
    await requireAdmin(request);
    const db = getAdminFirestore();
    await db.recursiveDelete(db.collection("groups").doc(PROBE_GROUP));
    await db.recursiveDelete(db.collection("courses").doc(PROBE_COURSE));
    const batch = db.batch();
    batch.delete(db.collection("studentEnrollments").doc(PROBE_ENROLLMENT));
    batch.delete(db.collection("planteles").doc(PROBE_PLANTEL));
    batch.delete(db.collection("satisfactionSurveys").doc(PROBE_SURVEY));
    Object.values(PROBE_IDS).forEach((uid) => batch.delete(db.collection("users").doc(uid)));
    await batch.commit();
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Response) {
      return NextResponse.json({ success: false, error: await error.text() }, { status: error.status });
    }
    console.error("rules-probe cleanup error", error);
    return NextResponse.json({ success: false, error: "No se pudo limpiar el sandbox" }, { status: 500 });
  }
}
