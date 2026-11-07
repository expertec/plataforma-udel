// Read-only audit. Prints aggregate counts, never credentials or student names.
/* eslint-disable @typescript-eslint/no-require-imports -- Node CommonJS CLI. */
const { loadEnvConfig } = require('@next/env');
const admin = require('firebase-admin');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const modules = new Map();
function load(name, parent = process.cwd()) {
  const filename = name.startsWith('@/') ? path.join(process.cwd(), 'src', `${name.slice(2)}.ts`)
    : path.resolve(path.dirname(parent), `${name}.ts`);
  if (modules.has(filename)) return modules.get(filename).exports;
  const loadedModule = { exports: {} };
  modules.set(filename, loadedModule);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(code, { module: loadedModule, exports: loadedModule.exports, Date, Intl,
    require: dependency => load(dependency, filename) }, { filename });
  return loadedModule.exports;
}
const { getAcademicAlert, academicAlertEvidence } = load('@/lib/students/academic-alert');
loadEnvConfig(process.cwd());
const credential = process.env.FIREBASE_SERVICE_ACCOUNT_KEY
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
  : {
      projectId: process.env.FIREBASE_ADMIN_PROJECT_ID,
      privateKey: process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
    };
admin.initializeApp({ credential: admin.credential.cert(credential) });
const db = admin.firestore();
db.settings({ preferRest: true });
const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const timeout = setTimeout(() => { console.error('Audit timed out connecting to Firestore.'); process.exit(1); }, 25000);
(async () => {
  const [enrollments, groups, courses, assignments] = await Promise.all([
    db.collection('studentEnrollments').select('studentId', 'groupId', 'groupName', 'status', 'courseClosures').get(),
    db.collection('groups').select('groupName', 'program', 'courses', 'courseId').get(),
    db.collection('courses').select('title', 'program', 'category', 'finalExam').get(),
    db.collection('globalExamAssignments').select('studentId', 'courseId', 'courseName', 'groupId', 'groupName', 'reason', 'status', 'passed', 'enabled', 'attemptsUsed', 'attemptsAllowed', 'examKind', 'expiresAt').get(),
  ]);
  const groupMap = new Map(groups.docs.map(doc => [doc.id, doc.data()]));
  const courseMap = new Map(courses.docs.map(doc => [doc.id, doc.data()]));
  const counts = { enrollments: enrollments.size, closed: 0, failed: 0, failedAutomatic: 0, failedCertifications: 0, failedWithoutEvaluations: 0, failedWithPendingGrading: 0 };
  const students = new Set();
  const perStudent = new Map();
  const studentRecords = id => {
    if (!perStudent.has(id)) perStudent.set(id, { closures: {}, assignments: [], before: new Set() });
    return perStudent.get(id);
  };
  for (const doc of assignments.docs) studentRecords(doc.data().studentId).assignments.push(doc.data());
  const byCourse = new Map();
  const closureKinds = {};
  const closureEvidence = { manualOverride: 0, campusFinalExam: 0, datedClosure: 0, noClosureDate: 0, completeGrading: 0 };
  const approved = new Set(assignments.docs.filter(doc => doc.data().passed || doc.data().status === 'passed').map(doc => `${doc.data().studentId}::${doc.data().courseId}`));
  for (const doc of enrollments.docs) {
    const e = doc.data();
    for (const [id, c] of Object.entries(e.courseClosures || {})) {
      if (c.status === 'closed' && typeof c.finalGrade === 'number' && c.finalGrade >= 70) approved.add(`${e.studentId}::${id}`);
    }
  }
  for (const doc of enrollments.docs) {
    const e = doc.data();
    if (['inactive', 'archived', 'baja'].includes(e.status)) continue;
    const g = groupMap.get(e.groupId) || {};
    for (const [id, c] of Object.entries(e.courseClosures || {})) {
      const course = courseMap.get(id) || {};
      const row = { ...c, ...academicAlertEvidence(c, e, g) };
      row.isCertification ||= /certificacion/.test(normalize(course.program || course.category));
      row.courseName ||= course.title;
      studentRecords(e.studentId).closures[`${doc.id}::${id}`] = row;
      if (c.status !== 'closed') continue;
      counts.closed++;
      if (typeof c.finalGrade !== 'number' || c.finalGrade > 49 || approved.has(`${e.studentId}::${id}`)) continue;
      studentRecords(e.studentId).before.add(id);
      const certification = /^CERT\./i.test(g.groupName || e.groupName || '') || /certificacion/.test(normalize(course.program || course.category));
      counts.failed++;
      const kind = `${c.closedByType || 'unspecified'}/${c.closureTrigger || 'unspecified'}/${c.gradeSource || 'unspecified'}`;
      closureKinds[kind] = (closureKinds[kind] || 0) + 1;
      if (c.manualOverride) closureEvidence.manualOverride++;
      if (typeof c.campusFinalExamGrade === 'number') closureEvidence.campusFinalExam++;
      if (c.closedAt) closureEvidence.datedClosure++; else closureEvidence.noClosureDate++;
      if (c.pendingUngradedCount === 0) closureEvidence.completeGrading++;
      students.add(e.studentId);
      if (c.closureTrigger === 'automatic') counts.failedAutomatic++;
      if (certification) counts.failedCertifications++;
      if (c.totalEvaluable === 0) counts.failedWithoutEvaluations++;
      if (c.pendingUngradedCount > 0) counts.failedWithPendingGrading++;
      const courseCounts = byCourse.get(id) || { courseId: id, title: course.title || c.courseName, program: course.program || course.category, hasFinalExam: !!course.finalExam, failed: 0, automatic: 0, certification: 0, zero: 0 };
      courseCounts.failed++;
      if (c.closureTrigger === 'automatic') courseCounts.automatic++;
      if (certification) courseCounts.certification++;
      if (c.finalGrade === 0) courseCounts.zero++;
      byCourse.set(id, courseCounts);
    }
  }
  const simulation = { studentsWithNoticeBefore: 0, studentsWithNoticeAfter: 0, studentsWhoseNoticeClears: 0, pendingCoursesBefore: 0, pendingCoursesAfter: 0 };
  for (const [id, records] of perStudent) {
    for (const exam of records.assignments) {
      if (exam.reason === 'failed_course' && exam.status !== 'disabled' && !approved.has(`${id}::${exam.courseId}`)) records.before.add(exam.courseId);
    }
    const result = getAcademicAlert(records.closures, {}, records.assignments, Date.now());
    if (records.before.size) simulation.studentsWithNoticeBefore++;
    if (result.notice) simulation.studentsWithNoticeAfter++;
    if (records.before.size && !result.notice) simulation.studentsWhoseNoticeClears++;
    simulation.pendingCoursesBefore += records.before.size;
    simulation.pendingCoursesAfter += result.notice ? Number(result.notice.match(/^Tienes (\d+)/)?.[1] || 0) : 0;
  }
  console.log(JSON.stringify({ counts, closureKinds, closureEvidence, simulation, studentsWithFailedClosures: students.size, failedAssignments: assignments.docs.filter(doc => doc.data().reason === 'failed_course' && !['passed', 'disabled'].includes(doc.data().status)).length, topCourses: [...byCourse.values()].sort((a, b) => b.failed - a.failed).slice(0, 8) }, null, 2));
})().catch(error => { console.error(error.code || error.name, error.message); process.exitCode = 1; }).finally(() => { clearTimeout(timeout); });
