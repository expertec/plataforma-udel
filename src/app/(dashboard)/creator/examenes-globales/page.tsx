"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Pencil, Plus, Search, X } from "lucide-react";
import toast from "react-hot-toast";
import { onAuthStateChanged } from "firebase/auth";
import { type DocumentSnapshot } from "firebase/firestore";
import { auth } from "@/lib/firebase/client";
import { Course, getCourses } from "@/lib/firebase/courses-service";
import {
  createGlobalExamAssignment,
  createGlobalExamTemplate,
  fetchGlobalExamAssignments,
  fetchGlobalExamTemplates,
  resolveGlobalExamCandidateEnrollments,
  updateGlobalExamAssignment,
  updateGlobalExamTemplate,
} from "@/lib/global-exams/client";
import {
  GLOBAL_EXAM_MAX_QUESTIONS,
  GLOBAL_EXAM_MIN_QUESTIONS,
  getGlobalExamCourseLabel,
  getGlobalExamReasonLabel,
  getGlobalExamStatusLabel,
  getGlobalExamTemplateStatusLabel,
  type GlobalExamAssignmentReason,
  type GlobalExamAssignmentRecord,
  type GlobalExamQuestion,
  type GlobalExamQuestionOption,
  type GlobalExamTemplateRecord,
} from "@/lib/global-exams/types";
import {
  getCoordinatorScopedStudents,
  getStudentUsersPaginated,
  type StudentUser,
} from "@/lib/firebase/students-service";
import { normalizeSearchText } from "@/lib/search";
import {
  isAdminTeacherRole,
  isCampusCoordinatorRole,
  resolveUserRole,
  type UserRole,
} from "@/lib/firebase/roles";
import { RoleGate } from "@/components/auth/RoleGate";

type CandidateEnrollment = {
  enrollmentId: string;
  groupId: string;
  groupName: string;
  courseId: string;
  courseName: string;
  plantelId: string;
  plantelName: string;
};

type QuestionFormState = {
  id: string;
  prompt: string;
  options: GlobalExamQuestionOption[];
  correctOptionId: string;
};

const BASE_OPTION_IDS = ["a", "b", "c", "d"];

function createBlankQuestion(index: number): QuestionFormState {
  const options = BASE_OPTION_IDS.map((optionId) => ({
    id: optionId,
    text: "",
  }));
  return {
    id: `question_${index + 1}`,
    prompt: "",
    options,
    correctOptionId: options[0].id,
  };
}

function createInitialQuestions(): QuestionFormState[] {
  return Array.from({ length: GLOBAL_EXAM_MIN_QUESTIONS }, (_, index) => createBlankQuestion(index));
}

function cloneTemplateQuestions(questions: GlobalExamQuestion[]): QuestionFormState[] {
  return questions.map((question, index) => ({
    id: question.id || `question_${index + 1}`,
    prompt: question.prompt,
    options: question.options.map((option) => ({
      id: option.id,
      text: option.text,
    })),
    correctOptionId: question.correctOptionId,
  }));
}

function formatElapsedTime(seconds: number | null | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
  const totalSeconds = Math.round(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours} h ${minutes.toString().padStart(2, "0")} min`;
  }
  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

export default function GlobalExamsPage() {
  const [userRole, setUserRole] = useState<UserRole | null>(null);
  const [loadingContext, setLoadingContext] = useState(true);
  const [loadingData, setLoadingData] = useState(true);
  const [activeTab, setActiveTab] = useState<"templates" | "assignments">("templates");
  const [templates, setTemplates] = useState<GlobalExamTemplateRecord[]>([]);
  const [assignments, setAssignments] = useState<GlobalExamAssignmentRecord[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [students, setStudents] = useState<StudentUser[]>([]);
  const [searchResults, setSearchResults] = useState<StudentUser[]>([]);
  const [studentSearch, setStudentSearch] = useState("");
  const [searchingStudents, setSearchingStudents] = useState(false);
  const searchStudentTokenRef = useRef(0);

  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [templateSearch, setTemplateSearch] = useState("");
  const [showTemplateForm, setShowTemplateForm] = useState(false);
  const [assignmentSearch, setAssignmentSearch] = useState("");
  const [templateTitle, setTemplateTitle] = useState("");
  const [templateDescription, setTemplateDescription] = useState("");
  const [templateCourseId, setTemplateCourseId] = useState("");
  const [templateCourseSearch, setTemplateCourseSearch] = useState("");
  const [templateStatus, setTemplateStatus] = useState<"draft" | "published">("draft");
  const [templateQuestions, setTemplateQuestions] = useState<QuestionFormState[]>(createInitialQuestions);
  const [savingTemplate, setSavingTemplate] = useState(false);

  const [showAssignmentForm, setShowAssignmentForm] = useState(false);
  const [assignmentTemplateId, setAssignmentTemplateId] = useState("");
  const [assignmentStudentId, setAssignmentStudentId] = useState("");
  const [assignmentGroupId, setAssignmentGroupId] = useState("");
  const [assignmentReason, setAssignmentReason] = useState<GlobalExamAssignmentReason>("failed_course");
  const [assignmentEnableNow, setAssignmentEnableNow] = useState(false);
  const [candidateEnrollments, setCandidateEnrollments] = useState<CandidateEnrollment[]>([]);
  const [resolvingEnrollments, setResolvingEnrollments] = useState(false);
  const [savingAssignment, setSavingAssignment] = useState(false);

  const isAdmin = isAdminTeacherRole(userRole);
  const isCoordinator = isCampusCoordinatorRole(userRole);
  const isStudentSearchActive = studentSearch.trim().length > 0;

  const STUDENT_RESULTS_LIMIT = 50;

  const availableStudents = useMemo(() => {
    const byId = new Map<string, StudentUser>();
    students.forEach((student) => byId.set(student.id, student));
    searchResults.forEach((student) => byId.set(student.id, student));
    return Array.from(byId.values());
  }, [students, searchResults]);

  const selectedStudent = useMemo(
    () => availableStudents.find((student) => student.id === assignmentStudentId) ?? null,
    [assignmentStudentId, availableStudents],
  );

  const filteredStudents = useMemo(() => {
    const query = normalizeSearchText(studentSearch);
    const searchBase =
      isStudentSearchActive && !isCoordinator
        ? searchResults
        : students;
    if (!query) return searchBase;
    return searchBase.filter((student) => {
      const haystack = normalizeSearchText([student.name, student.email, student.program].join(" "));
      return haystack.includes(query);
    });
  }, [studentSearch, students, searchResults, isStudentSearchActive, isCoordinator]);

  const visibleStudents = useMemo(
    () => filteredStudents.slice(0, STUDENT_RESULTS_LIMIT),
    [filteredStudents],
  );

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === assignmentTemplateId) ?? null,
    [assignmentTemplateId, templates],
  );
  const selectedTemplateCourse = useMemo(
    () => courses.find((course) => course.id === templateCourseId) ?? null,
    [courses, templateCourseId],
  );
  const filteredTemplateCourses = useMemo(() => {
    const query = templateCourseSearch.trim().toLowerCase();
    if (!query) return courses.slice(0, 8);
    return courses
      .filter((course) => course.title.toLowerCase().includes(query))
      .slice(0, 8);
  }, [courses, templateCourseSearch]);

  const filteredTemplates = useMemo(() => {
    const query = normalizeSearchText(templateSearch);
    if (!query) return templates;
    return templates.filter((template) => {
      const haystack = normalizeSearchText(
        [
          template.title,
          template.courseName,
          template.description,
          getGlobalExamTemplateStatusLabel(template.status),
        ].join(" "),
      );
      return haystack.includes(query);
    });
  }, [templates, templateSearch]);

  const filteredAssignments = useMemo(() => {
    const query = normalizeSearchText(assignmentSearch);
    if (!query) return assignments;
    return assignments.filter((assignment) => {
      const haystack = normalizeSearchText(
        [
          assignment.studentName,
          assignment.studentEmail,
          assignment.courseName,
          assignment.groupName,
          assignment.templateTitle,
          assignment.plantelName,
          getGlobalExamStatusLabel(assignment.status),
        ].join(" "),
      );
      return haystack.includes(query);
    });
  }, [assignments, assignmentSearch]);

  const canCreateTemplates = isAdmin;

  const persistSelectedStudent = (student: StudentUser) => {
    setStudents((prev) => {
      if (prev.some((item) => item.id === student.id)) return prev;
      return [student, ...prev];
    });
    setAssignmentStudentId(student.id);
    setStudentSearch("");
  };

  const resetTemplateForm = () => {
    setEditingTemplateId(null);
    setTemplateTitle("");
    setTemplateDescription("");
    setTemplateCourseId("");
    setTemplateCourseSearch("");
    setTemplateStatus("draft");
    setTemplateQuestions(createInitialQuestions());
  };

  const openNewTemplateForm = () => {
    resetTemplateForm();
    setShowTemplateForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const closeTemplateForm = () => {
    resetTemplateForm();
    setShowTemplateForm(false);
  };

  const loadAllData = async (role: UserRole | null) => {
    setLoadingData(true);
    try {
      const roleIsAdmin = isAdminTeacherRole(role);
      const roleIsCoordinator = isCampusCoordinatorRole(role);
      const templatePromise = fetchGlobalExamTemplates();
      const assignmentPromise = fetchGlobalExamAssignments();
      const studentPromise = roleIsCoordinator
        ? getCoordinatorScopedStudents().then((result) => result.students)
        : getStudentUsersPaginated(500).then((result) => result.students);
      const coursePromise = roleIsAdmin ? getCourses(undefined, 500) : Promise.resolve<Course[]>([]);

      const [loadedTemplates, loadedAssignments, loadedStudents, loadedCourses] = await Promise.all([
        templatePromise,
        assignmentPromise,
        studentPromise,
        coursePromise,
      ]);
      setTemplates(loadedTemplates);
      setAssignments(loadedAssignments);
      setStudents(loadedStudents);
      setCourses(loadedCourses);
    } catch (error) {
      console.error(error);
      toast.error(
        error instanceof Error ? error.message : "No se pudo cargar la configuracion del examen global",
      );
    } finally {
      setLoadingData(false);
    }
  };

  useEffect(() => {
    const rawQuery = normalizeSearchText(studentSearch);
    if (!rawQuery) {
      searchStudentTokenRef.current += 1;
      setSearchResults([]);
      setSearchingStudents(false);
      return;
    }

    if (isCoordinator) {
      setSearchResults([]);
      setSearchingStudents(false);
      return;
    }

    const token = ++searchStudentTokenRef.current;
    const timer = window.setTimeout(async () => {
      setSearchingStudents(true);
      setSearchResults([]);
      try {
        const normalized = rawQuery;
        const results = new Map<string, StudentUser>();
        let last: DocumentSnapshot | null = null;
        let hasMore = true;
        let pageCount = 0;
        const MAX_PAGES = 60;
        const PAGE_SIZE = 50;

        while (hasMore && pageCount < MAX_PAGES) {
          const page = await getStudentUsersPaginated(PAGE_SIZE, last, normalized);
          if (searchStudentTokenRef.current !== token) return;

          page.students.forEach((student) => {
            results.set(student.id, student);
          });

          last = page.lastDoc;
          hasMore = page.hasMore;
          pageCount += 1;

          if (results.size >= 50) break;
        }

        if (searchStudentTokenRef.current !== token) return;
        setSearchResults(Array.from(results.values()));
      } catch (error) {
        console.error(error);
        if (searchStudentTokenRef.current === token) {
          toast.error("No se pudo buscar alumnos");
        }
      } finally {
        if (searchStudentTokenRef.current === token) {
          setSearchingStudents(false);
        }
      }
    }, 350);

    return () => {
      window.clearTimeout(timer);
    };
  }, [studentSearch, isCoordinator]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setUserRole(null);
        setLoadingContext(false);
        return;
      }

      setLoadingContext(true);
      try {
        const role = await resolveUserRole(user);
        setUserRole(role);
        if (!role) {
          setTemplates([]);
          setAssignments([]);
          setStudents([]);
          setCourses([]);
          return;
        }
        await loadAllData(role);
      } catch (error) {
        console.error(error);
        setUserRole(null);
        toast.error("No se pudo validar tu rol para administrar examenes globales");
      } finally {
        setLoadingContext(false);
      }
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!assignmentTemplateId || !assignmentStudentId) {
      setCandidateEnrollments([]);
      setAssignmentGroupId("");
      return;
    }

    let active = true;
    const resolveCandidates = async () => {
      setResolvingEnrollments(true);
      try {
        const enrollments = await resolveGlobalExamCandidateEnrollments(
          assignmentStudentId,
          assignmentTemplateId,
        );
        if (!active) return;
        setCandidateEnrollments(enrollments);
        setAssignmentGroupId((current) => {
          if (current && enrollments.some((enrollment) => enrollment.groupId === current)) {
            return current;
          }
          return enrollments[0]?.groupId ?? "";
        });
      } catch (error) {
        console.error(error);
        if (!active) return;
        setCandidateEnrollments([]);
        setAssignmentGroupId("");
        toast.error(
          error instanceof Error
            ? error.message
            : "No se pudieron resolver los grupos disponibles para el alumno",
        );
      } finally {
        if (active) setResolvingEnrollments(false);
      }
    };

    void resolveCandidates();
    return () => {
      active = false;
    };
  }, [assignmentStudentId, assignmentTemplateId]);

  useEffect(() => {
    if (!showTemplateForm && !showAssignmentForm) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowTemplateForm(false);
        setShowAssignmentForm(false);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [showTemplateForm, showAssignmentForm]);

  const handleTemplateCourseSearchChange = (value: string) => {
    setTemplateCourseSearch(value);
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      setTemplateCourseId("");
      return;
    }
    const exactMatch = courses.find((course) => course.title.trim().toLowerCase() === normalized);
    setTemplateCourseId(exactMatch?.id ?? "");
  };

  const handleTemplateCourseSelect = (course: Course) => {
    setTemplateCourseId(course.id);
    setTemplateCourseSearch(course.title);
  };

  const handleQuestionChange = (
    questionId: string,
    updater: (current: QuestionFormState) => QuestionFormState,
  ) => {
    setTemplateQuestions((prev) =>
      prev.map((question) => (question.id === questionId ? updater(question) : question)),
    );
  };

  const handleAddQuestion = () => {
    setTemplateQuestions((prev) => {
      if (prev.length >= GLOBAL_EXAM_MAX_QUESTIONS) return prev;
      return [...prev, createBlankQuestion(prev.length)];
    });
  };

  const handleRemoveQuestion = (questionId: string) => {
    setTemplateQuestions((prev) => {
      if (prev.length <= GLOBAL_EXAM_MIN_QUESTIONS) return prev;
      return prev.filter((question) => question.id !== questionId);
    });
  };

  const handleSubmitTemplate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (templateCourseSearch.trim() && !templateCourseId) {
      toast.error("Selecciona una materia valida o deja el campo vacio");
      return;
    }

    const selectedCourse = courses.find((course) => course.id === templateCourseId);
    if (templateCourseId && !selectedCourse) {
      toast.error("No se encontro la materia seleccionada");
      return;
    }

    const payloadQuestions: GlobalExamQuestion[] = templateQuestions.map((question, index) => ({
      id: question.id || `question_${index + 1}`,
      prompt: question.prompt,
      options: question.options,
      correctOptionId: question.correctOptionId,
    }));

    setSavingTemplate(true);
    try {
      const saved = editingTemplateId
        ? await updateGlobalExamTemplate(editingTemplateId, {
            title: templateTitle,
            description: templateDescription,
            courseId: selectedCourse?.id ?? "",
            courseName: selectedCourse?.title ?? "",
            status: templateStatus,
            questions: payloadQuestions,
          })
        : await createGlobalExamTemplate({
            title: templateTitle,
            description: templateDescription,
            courseId: selectedCourse?.id ?? "",
            courseName: selectedCourse?.title ?? "",
            status: templateStatus,
            questions: payloadQuestions,
          });

      setTemplates((prev) => {
        const next = prev.filter((template) => template.id !== saved.id);
        return [saved, ...next].sort((left, right) =>
          (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""),
        );
      });
      toast.success(editingTemplateId ? "Plantilla actualizada" : "Plantilla creada");
      resetTemplateForm();
      setShowTemplateForm(false);
      setActiveTab("templates");
    } catch (error) {
      console.error(error);
      toast.error(error instanceof Error ? error.message : "No se pudo guardar la plantilla");
    } finally {
      setSavingTemplate(false);
    }
  };

  const handleEditTemplate = (template: GlobalExamTemplateRecord) => {
    setEditingTemplateId(template.id);
    setTemplateTitle(template.title);
    setTemplateDescription(template.description);
    setTemplateCourseId(template.courseId);
    setTemplateCourseSearch(template.courseName);
    setTemplateStatus(template.status);
    setTemplateQuestions(cloneTemplateQuestions(template.questions));
    setActiveTab("templates");
    setShowTemplateForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleToggleTemplateStatus = async (template: GlobalExamTemplateRecord) => {
    try {
      const nextStatus = template.status === "published" ? "draft" : "published";
      const updated = await updateGlobalExamTemplate(template.id, { status: nextStatus });
      setTemplates((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      toast.success(
        nextStatus === "published" ? "Plantilla publicada" : "Plantilla regresada a borrador",
      );
    } catch (error) {
      console.error(error);
      toast.error(error instanceof Error ? error.message : "No se pudo actualizar la plantilla");
    }
  };

  const handleSubmitAssignment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!assignmentTemplateId || !assignmentStudentId) {
      toast.error("Selecciona plantilla y alumno");
      return;
    }

    setSavingAssignment(true);
    try {
      const created = await createGlobalExamAssignment({
        templateId: assignmentTemplateId,
        studentId: assignmentStudentId,
        groupId: assignmentGroupId,
        reason: assignmentReason,
        enabled: assignmentEnableNow,
      });
      setAssignments((prev) => [created, ...prev]);
      setAssignmentStudentId("");
      setAssignmentTemplateId("");
      setAssignmentGroupId("");
      setAssignmentReason("failed_course");
      setAssignmentEnableNow(false);
      setCandidateEnrollments([]);
      toast.success("Asignacion creada");
      setShowAssignmentForm(false);
      setActiveTab("assignments");
    } catch (error) {
      console.error(error);
      toast.error(error instanceof Error ? error.message : "No se pudo crear la asignacion");
    } finally {
      setSavingAssignment(false);
    }
  };

  const resetAssignmentForm = () => {
    setAssignmentStudentId("");
    setAssignmentTemplateId("");
    setAssignmentGroupId("");
    setAssignmentReason("failed_course");
    setAssignmentEnableNow(false);
    setCandidateEnrollments([]);
    setStudentSearch("");
  };

  const openAssignmentForm = () => {
    resetAssignmentForm();
    setShowAssignmentForm(true);
  };

  const closeAssignmentForm = () => {
    resetAssignmentForm();
    setShowAssignmentForm(false);
  };

  const handleToggleAssignment = async (assignment: GlobalExamAssignmentRecord, enabled: boolean) => {
    try {
      const updated = await updateGlobalExamAssignment(assignment.id, { enabled });
      setAssignments((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      toast.success(enabled ? "Examen habilitado" : "Examen deshabilitado");
    } catch (error) {
      console.error(error);
      toast.error(error instanceof Error ? error.message : "No se pudo actualizar la asignacion");
    }
  };

  if (loadingContext) {
    return (
      <RoleGate allowedRole={["coordinadorPlantel", "director", "adminTeacher", "superAdminTeacher"]}>
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">
          Cargando examen global...
        </div>
      </RoleGate>
    );
  }

  return (
    <RoleGate allowedRole={["coordinadorPlantel", "director", "adminTeacher", "superAdminTeacher"]}>
      <div className="space-y-6 text-slate-900">
        <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-[0.25em] text-slate-500">Regularizacion</p>
            <h1 className="text-3xl font-semibold">Examen global</h1>
            <p className="max-w-3xl text-sm text-slate-600">
              Administra plantillas de regularizacion, habilita examenes solo a alumnos
              puntuales y sincroniza automaticamente la nota final con kardex.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/creator/alumnos"
              className="inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-800 shadow-sm transition hover:border-blue-500 hover:text-blue-700"
            >
              Ver alumnos
            </Link>
            <Link
              href="/creator"
              className="inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-800 shadow-sm transition hover:border-blue-500 hover:text-blue-700"
            >
              Volver al dashboard
            </Link>
          </div>
        </header>

        <section className="grid gap-4 xl:grid-cols-4">
          <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Plantillas</p>
            <p className="mt-2 text-3xl font-semibold">{templates.length}</p>
            <p className="mt-1 text-sm text-slate-600">
              {templates.filter((template) => template.status === "published").length} publicadas
            </p>
          </article>
          <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Asignaciones</p>
            <p className="mt-2 text-3xl font-semibold">{assignments.length}</p>
            <p className="mt-1 text-sm text-slate-600">
              {assignments.filter((assignment) => assignment.status === "enabled").length} habilitadas
            </p>
          </article>
          <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Aprobados</p>
            <p className="mt-2 text-3xl font-semibold">
              {assignments.filter((assignment) => assignment.status === "passed").length}
            </p>
            <p className="mt-1 text-sm text-slate-600">Con nota final sincronizada al cierre</p>
          </article>
          <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Cobertura</p>
            <p className="mt-2 text-3xl font-semibold">{students.length}</p>
            <p className="mt-1 text-sm text-slate-600">
              alumnos accesibles para {isCoordinator ? "tu plantel" : "la operacion"}
            </p>
          </article>
        </section>

        <section className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setActiveTab("templates")}
            className={`rounded-full px-4 py-2 text-sm font-medium transition ${
              activeTab === "templates"
                ? "bg-slate-900 text-white"
                : "border border-slate-200 bg-white text-slate-700 hover:border-slate-300"
            }`}
          >
            Plantillas
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("assignments")}
            className={`rounded-full px-4 py-2 text-sm font-medium transition ${
              activeTab === "assignments"
                ? "bg-slate-900 text-white"
                : "border border-slate-200 bg-white text-slate-700 hover:border-slate-300"
            }`}
          >
            Asignaciones
          </button>
        </section>

        {loadingData ? (
          <section className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">
            Cargando configuracion del examen global...
          </section>
        ) : null}

        {!loadingData && activeTab === "templates" ? (
          <div className="space-y-5">
            <section className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
              <div className="relative w-full sm:max-w-md">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  value={templateSearch}
                  onChange={(event) => setTemplateSearch(event.target.value)}
                  placeholder="Buscar plantilla por nombre, materia o estado..."
                  className="w-full rounded-xl border border-slate-200 px-3 py-2.5 pl-9 text-sm outline-none transition focus:border-blue-500"
                />
                {templateSearch ? (
                  <button
                    type="button"
                    onClick={() => setTemplateSearch("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                    aria-label="Limpiar busqueda"
                  >
                    <X className="h-4 w-4" />
                  </button>
                ) : null}
              </div>
              {canCreateTemplates && !showTemplateForm ? (
                <button
                  type="button"
                  onClick={openNewTemplateForm}
                  className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800"
                >
                  <Plus className="h-4 w-4" />
                  Nueva plantilla
                </button>
              ) : null}
            </section>

            {!canCreateTemplates ? (
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
                Como coordinacion puedes consultar plantillas publicadas, pero la creacion y edicion
                quedan reservadas a adminTeacher y superAdminTeacher.
              </div>
            ) : null}

            {showTemplateForm && canCreateTemplates ? (
            <div className="fixed inset-0 z-50 flex justify-center overflow-y-auto bg-slate-900/50 p-4 backdrop-blur-sm">
              <div className="relative my-6 h-fit w-full max-w-4xl rounded-2xl bg-white shadow-2xl">
                <div className="sticky top-0 z-10 flex items-center justify-between gap-3 rounded-t-2xl border-b border-slate-200 bg-white px-5 py-4">
                  <div>
                    <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Configuracion</p>
                    <h2 className="text-xl font-semibold text-slate-900">
                      {editingTemplateId ? "Editar plantilla" : "Nueva plantilla"}
                    </h2>
                  </div>
                  <button
                    type="button"
                    onClick={closeTemplateForm}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:border-slate-300"
                  >
                    <X className="h-4 w-4" />
                    Cerrar
                  </button>
                </div>
                <div className="space-y-5 p-5">

              {canCreateTemplates ? (
                <form className="space-y-5" onSubmit={handleSubmitTemplate}>
                  <div className="grid gap-4 lg:grid-cols-2">
                    <label className="space-y-2 text-sm">
                      <span className="font-medium text-slate-700">Titulo del examen</span>
                      <input
                        value={templateTitle}
                        onChange={(event) => setTemplateTitle(event.target.value)}
                        placeholder="Examen global de regularizacion"
                        className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none transition focus:border-blue-500"
                        required
                      />
                    </label>
                    <label className="space-y-2 text-sm">
                      <span className="font-medium text-slate-700">Materia (opcional)</span>
                      <input
                        value={templateCourseSearch}
                        onChange={(event) => handleTemplateCourseSearchChange(event.target.value)}
                        placeholder="Busca una materia por nombre"
                        className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none transition focus:border-blue-500"
                      />
                      <div className="rounded-xl border border-slate-200 bg-white p-2">
                        <button
                          type="button"
                          onClick={() => {
                            setTemplateCourseId("");
                            setTemplateCourseSearch("");
                          }}
                          className="w-full rounded-lg px-2 py-1.5 text-left text-xs font-medium text-slate-600 transition hover:bg-slate-50"
                        >
                          Sin materia
                        </button>
                        {filteredTemplateCourses.map((course) => (
                          <button
                            key={course.id}
                            type="button"
                            onClick={() => handleTemplateCourseSelect(course)}
                            className={`w-full rounded-lg px-2 py-1.5 text-left text-xs transition ${
                              templateCourseId === course.id
                                ? "bg-blue-50 font-semibold text-blue-700"
                                : "text-slate-700 hover:bg-slate-50"
                            }`}
                          >
                            {course.title}
                          </button>
                        ))}
                      </div>
                      <p className="text-xs text-slate-500">
                        {templateCourseId
                          ? `Materia seleccionada: ${selectedTemplateCourse?.title ?? templateCourseSearch}`
                          : "Si lo dejas vacio, el examen no quedara ligado a una materia."}
                      </p>
                    </label>
                    <label className="space-y-2 text-sm lg:col-span-2">
                      <span className="font-medium text-slate-700">Descripcion u observaciones</span>
                      <textarea
                        value={templateDescription}
                        onChange={(event) => setTemplateDescription(event.target.value)}
                        rows={3}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none transition focus:border-blue-500"
                        placeholder="Instrucciones internas para coordinacion o contexto del examen."
                      />
                    </label>
                    <label className="space-y-2 text-sm lg:max-w-xs">
                      <span className="font-medium text-slate-700">Estado</span>
                      <select
                        value={templateStatus}
                        onChange={(event) => setTemplateStatus(event.target.value as "draft" | "published")}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none transition focus:border-blue-500"
                      >
                        <option value="draft">Borrador</option>
                        <option value="published">Publicado</option>
                      </select>
                    </label>
                  </div>

                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Reactivos</p>
                        <h3 className="text-lg font-semibold text-slate-900">
                          {templateQuestions.length} preguntas configuradas
                        </h3>
                        <p className="text-sm text-slate-600">
                          Debe mantenerse entre {GLOBAL_EXAM_MIN_QUESTIONS} y {GLOBAL_EXAM_MAX_QUESTIONS} preguntas.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={handleAddQuestion}
                        disabled={templateQuestions.length >= GLOBAL_EXAM_MAX_QUESTIONS}
                        className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        + Agregar pregunta
                      </button>
                    </div>

                    <div className="mt-4 space-y-4">
                      {templateQuestions.map((question, questionIndex) => (
                        <article
                          key={question.id}
                          className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
                        >
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div>
                              <p className="text-xs uppercase tracking-[0.15em] text-slate-500">
                                Pregunta {questionIndex + 1}
                              </p>
                              <p className="text-sm text-slate-600">
                                Marca una sola respuesta correcta.
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => handleRemoveQuestion(question.id)}
                              disabled={templateQuestions.length <= GLOBAL_EXAM_MIN_QUESTIONS}
                              className="rounded-lg border border-rose-200 px-3 py-2 text-xs font-semibold text-rose-700 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              Eliminar
                            </button>
                          </div>

                          <label className="mt-4 block space-y-2 text-sm">
                            <span className="font-medium text-slate-700">Enunciado</span>
                            <textarea
                              value={question.prompt}
                              onChange={(event) =>
                                handleQuestionChange(question.id, (current) => ({
                                  ...current,
                                  prompt: event.target.value,
                                }))
                              }
                              rows={2}
                              className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none transition focus:border-blue-500"
                              required
                            />
                          </label>

                          <div className="mt-4 grid gap-3 lg:grid-cols-2">
                            {question.options.map((option) => (
                              <label
                                key={`${question.id}-${option.id}`}
                                className={`rounded-2xl border px-3 py-3 text-sm transition ${
                                  question.correctOptionId === option.id
                                    ? "border-emerald-300 bg-emerald-50"
                                    : "border-slate-200 bg-slate-50"
                                }`}
                              >
                                <div className="flex items-start gap-3">
                                  <input
                                    type="radio"
                                    name={`correct-${question.id}`}
                                    checked={question.correctOptionId === option.id}
                                    onChange={() =>
                                      handleQuestionChange(question.id, (current) => ({
                                        ...current,
                                        correctOptionId: option.id,
                                      }))
                                    }
                                    className="mt-1 h-4 w-4 accent-emerald-600"
                                  />
                                  <div className="min-w-0 flex-1 space-y-2">
                                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                                      Opcion {option.id.toUpperCase()}
                                    </p>
                                    <input
                                      value={option.text}
                                      onChange={(event) =>
                                        handleQuestionChange(question.id, (current) => ({
                                          ...current,
                                          options: current.options.map((candidate) =>
                                            candidate.id === option.id
                                              ? { ...candidate, text: event.target.value }
                                              : candidate,
                                          ),
                                        }))
                                      }
                                      className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-blue-500"
                                      required
                                    />
                                  </div>
                                </div>
                              </label>
                            ))}
                          </div>
                        </article>
                      ))}
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={savingTemplate}
                    className="inline-flex items-center justify-center rounded-xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {savingTemplate
                      ? "Guardando..."
                      : editingTemplateId
                        ? "Actualizar plantilla"
                        : "Crear plantilla"}
                  </button>
                </form>
              ) : null}
                </div>
              </div>
            </div>
            ) : null}

            <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Catalogo</p>
                  <h2 className="text-xl font-semibold text-slate-900">Plantillas registradas</h2>
                </div>
                <span className="shrink-0 rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
                  {templateSearch
                    ? `${filteredTemplates.length} de ${templates.length}`
                    : `${templates.length} total`}
                </span>
              </div>

              {templates.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-5 text-sm text-slate-600">
                  Aun no existen plantillas de examen global.
                </div>
              ) : filteredTemplates.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-5 text-sm text-slate-600">
                  No hay plantillas que coincidan con tu busqueda.
                </div>
              ) : (
                <div className="grid gap-3 lg:grid-cols-2">
                  {filteredTemplates.map((template) => (
                    <article
                      key={template.id}
                      className={`rounded-2xl border bg-slate-50 p-4 transition ${
                        editingTemplateId === template.id
                          ? "border-blue-300 ring-2 ring-blue-100"
                          : "border-slate-200"
                      }`}
                    >
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="text-lg font-semibold text-slate-900">{template.title}</h3>
                            <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-700">
                              {getGlobalExamTemplateStatusLabel(template.status)}
                            </span>
                          </div>
                          <p className="text-sm text-slate-600">{getGlobalExamCourseLabel(template.courseName)}</p>
                          <p className="text-xs text-slate-500">
                            {template.questionCount} preguntas | Pase con {template.passScore}
                          </p>
                        </div>
                        {canCreateTemplates ? (
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => handleEditTemplate(template)}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:border-blue-300 hover:text-blue-700"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                              Editar
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleToggleTemplateStatus(template)}
                              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700"
                            >
                              {template.status === "published" ? "Pasar a borrador" : "Publicar"}
                            </button>
                          </div>
                        ) : null}
                      </div>
                      {template.description ? (
                        <p className="mt-3 text-sm text-slate-600">{template.description}</p>
                      ) : null}
                    </article>
                  ))}
                </div>
              )}
            </section>
          </div>
        ) : null}

        {!loadingData && activeTab === "assignments" ? (
          <div className="space-y-5">
            <section className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
              <div className="relative w-full sm:max-w-md">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  value={assignmentSearch}
                  onChange={(event) => setAssignmentSearch(event.target.value)}
                  placeholder="Buscar por alumno, materia, grupo o plantilla..."
                  className="w-full rounded-xl border border-slate-200 px-3 py-2.5 pl-9 text-sm outline-none transition focus:border-blue-500"
                />
                {assignmentSearch ? (
                  <button
                    type="button"
                    onClick={() => setAssignmentSearch("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                    aria-label="Limpiar busqueda"
                  >
                    <X className="h-4 w-4" />
                  </button>
                ) : null}
              </div>
              <button
                type="button"
                onClick={openAssignmentForm}
                className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800"
              >
                <Plus className="h-4 w-4" />
                Nueva asignacion
              </button>
            </section>

            {showAssignmentForm ? (
            <div className="fixed inset-0 z-50 flex justify-center overflow-y-auto bg-slate-900/50 p-4 backdrop-blur-sm">
              <div className="relative my-6 h-fit w-full max-w-2xl rounded-2xl bg-white shadow-2xl">
                <div className="sticky top-0 z-10 flex items-center justify-between gap-3 rounded-t-2xl border-b border-slate-200 bg-white px-5 py-4">
                  <div>
                    <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Alumno puntual</p>
                    <h2 className="text-xl font-semibold text-slate-900">Nueva asignacion</h2>
                  </div>
                  <button
                    type="button"
                    onClick={closeAssignmentForm}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:border-slate-300"
                  >
                    <X className="h-4 w-4" />
                    Cerrar
                  </button>
                </div>
                <div className="p-5">
                  <p className="mb-4 text-sm text-slate-600">
                    El examen solo quedara disponible para el alumno y grupo elegidos.
                  </p>
                  <form className="space-y-4" onSubmit={handleSubmitAssignment}>
                <label className="space-y-2 text-sm">
                  <span className="font-medium text-slate-700">Plantilla publicada</span>
                  <select
                    value={assignmentTemplateId}
                    onChange={(event) => setAssignmentTemplateId(event.target.value)}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none transition focus:border-blue-500"
                    required
                  >
                    <option value="">Selecciona una plantilla</option>
                    {templates
                      .filter((template) => template.status === "published")
                      .map((template) => (
                        <option key={template.id} value={template.id}>
                          {template.title} | {getGlobalExamCourseLabel(template.courseName)}
                        </option>
                      ))}
                  </select>
                </label>

                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-slate-700">Alumno</span>
                    {selectedStudent ? (
                      <button
                        type="button"
                        onClick={() => {
                          setAssignmentStudentId("");
                          setStudentSearch("");
                        }}
                        className="text-xs font-medium text-blue-700 hover:underline"
                      >
                        Cambiar
                      </button>
                    ) : null}
                  </div>

                  {selectedStudent ? (
                    <div className="rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2.5">
                      <p className="text-sm font-semibold text-slate-900">{selectedStudent.name}</p>
                      <p className="text-xs text-slate-600">
                        {selectedStudent.email || "sin correo"}
                        {selectedStudent.program ? ` | ${selectedStudent.program}` : ""}
                      </p>
                    </div>
                  ) : (
                    <>
                      <input
                        value={studentSearch}
                        onChange={(event) => setStudentSearch(event.target.value)}
                        placeholder="Busca por nombre, correo o programa"
                        className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none transition focus:border-blue-500"
                      />
                      {studentSearch.trim() ? (
                        <>
                          <div className="max-h-64 overflow-y-auto rounded-xl border border-slate-200 bg-white">
                            {searchingStudents ? (
                              <p className="px-3 py-3 text-xs text-slate-500">Buscando alumnos...</p>
                            ) : visibleStudents.length === 0 ? (
                              <p className="px-3 py-3 text-xs text-slate-500">
                                {students.length === 0
                                  ? "No hay alumnos disponibles para tu alcance."
                                  : "Sin coincidencias. Ajusta tu búsqueda."}
                              </p>
                            ) : (
                              visibleStudents.map((student) => (
                                <button
                                  key={student.id}
                                  type="button"
                                  onClick={() => {
                                    persistSelectedStudent(student);
                                  }}
                                  className="block w-full border-b border-slate-100 px-3 py-2 text-left transition last:border-b-0 hover:bg-blue-50"
                                >
                                  <span className="block text-sm font-medium text-slate-800">
                                    {student.name}
                                  </span>
                                  <span className="block text-xs text-slate-500">
                                    {student.email || "sin correo"}
                                    {student.program ? ` | ${student.program}` : ""}
                                  </span>
                                </button>
                              ))
                            )}
                          </div>
                          {filteredStudents.length > visibleStudents.length ? (
                            <p className="text-xs text-slate-500">
                              Mostrando {visibleStudents.length} de {filteredStudents.length}. Refina
                              tu búsqueda para acotar.
                            </p>
                          ) : null}
                        </>
                      ) : null}
                    </>
                  )}
                </div>

                <div className="grid gap-4 lg:grid-cols-2">
                  <label className="space-y-2 text-sm">
                    <span className="font-medium text-slate-700">Motivo</span>
                    <select
                      value={assignmentReason}
                      onChange={(event) => setAssignmentReason(event.target.value as GlobalExamAssignmentReason)}
                      className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none transition focus:border-blue-500"
                    >
                      <option value="failed_course">Alumno reprobado</option>
                      <option value="late_joiner">Alumno que se incorporo tarde</option>
                    </select>
                  </label>

                  <label className="space-y-2 text-sm">
                    <span className="font-medium text-slate-700">
                      Grupo para regularizacion{" "}
                      <span className="font-normal text-slate-400">(opcional)</span>
                    </span>
                    <select
                      value={assignmentGroupId}
                      onChange={(event) => setAssignmentGroupId(event.target.value)}
                      className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none transition focus:border-blue-500"
                      disabled={resolvingEnrollments || candidateEnrollments.length === 0}
                    >
                      <option value="">
                        {resolvingEnrollments ? "Resolviendo grupos..." : "Sin grupo"}
                      </option>
                      {candidateEnrollments.map((enrollment) => (
                        <option key={enrollment.groupId} value={enrollment.groupId}>
                          {enrollment.groupName}
                          {enrollment.plantelName ? ` | ${enrollment.plantelName}` : ""}
                        </option>
                      ))}
                    </select>
                    {!resolvingEnrollments &&
                    assignmentStudentId &&
                    assignmentTemplateId &&
                    candidateEnrollments.length === 0 ? (
                      <p className="text-xs text-amber-600">
                        {selectedTemplate?.courseId
                          ? "No se encontró una inscripción actual o histórica utilizable para esta materia. Aun así, al crear la asignación el sistema generará un acceso técnico para reflejar la calificación en kardex y abrir la materia en modo estudio."
                          : "Esta plantilla no está ligada a una materia, por lo que no hay nota que sincronizar ni contenido que desbloquear."}
                      </p>
                    ) : (
                      <p className="text-xs text-slate-500">
                        Opcional: si lo dejas en &quot;Sin grupo&quot;, el sistema usará
                        automáticamente la inscripción del alumno en esta materia para sincronizar la
                        nota a kardex y desbloquear el contenido en modo estudio.
                      </p>
                    )}
                  </label>
                </div>

                {selectedTemplate ? (
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                    <p className="font-semibold text-slate-900">{selectedTemplate.title}</p>
                    <p className="mt-1">
                      {getGlobalExamCourseLabel(selectedTemplate.courseName)} |{" "}
                      {selectedTemplate.questionCount} preguntas | pase con{" "}
                      {selectedTemplate.passScore}
                    </p>
                  </div>
                ) : null}

                <label className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={assignmentEnableNow}
                    onChange={(event) => setAssignmentEnableNow(event.target.checked)}
                    className="mt-1 h-4 w-4 accent-emerald-600"
                  />
                  <span>
                    Marcar pago verificado y habilitar inmediatamente.
                    <span className="block text-xs text-slate-500">
                      Si lo dejas apagado, la asignacion quedara en borrador para activarla despues.
                    </span>
                  </span>
                </label>

                <button
                  type="submit"
                  disabled={savingAssignment}
                  className="inline-flex items-center justify-center rounded-xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {savingAssignment ? "Guardando..." : "Crear asignacion"}
                </button>
              </form>
                </div>
              </div>
            </div>
            ) : null}

            <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Operacion</p>
                  <h2 className="text-xl font-semibold text-slate-900">Asignaciones existentes</h2>
                </div>
                <span className="shrink-0 rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
                  {assignmentSearch
                    ? `${filteredAssignments.length} de ${assignments.length}`
                    : `${assignments.length} total`}
                </span>
              </div>

              {assignments.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-5 text-sm text-slate-600">
                  Aun no existen asignaciones para examen global.
                </div>
              ) : filteredAssignments.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-5 text-sm text-slate-600">
                  No hay asignaciones que coincidan con tu busqueda.
                </div>
              ) : (
                <div className="space-y-3">
                  {filteredAssignments.map((assignment) => {
                    const canToggle =
                      assignment.status === "draft" ||
                      assignment.status === "enabled" ||
                      assignment.status === "disabled" ||
                      // Reprobado: el adminTeacher puede rehabilitar para conceder otro intento.
                      assignment.status === "failed";
                    const latestAttemptDuration = formatElapsedTime(assignment.latestAttemptDurationSeconds);

                    return (
                      <article
                        key={assignment.id}
                        className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                      >
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <h3 className="text-lg font-semibold text-slate-900">
                                {assignment.studentName}
                              </h3>
                              <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-700">
                                {getGlobalExamStatusLabel(assignment.status)}
                              </span>
                            </div>
                            <p className="text-sm text-slate-600">
                              {getGlobalExamCourseLabel(assignment.courseName)} | {assignment.groupName}
                            </p>
                            <p className="text-xs text-slate-500">
                              {getGlobalExamReasonLabel(assignment.reason)} | Intentos:{" "}
                              {assignment.attemptsUsed}/{assignment.attemptsAllowed}
                            </p>
                            {assignment.latestScore !== null ? (
                              <p className="text-xs font-medium text-slate-600">
                                Ultima nota: {assignment.latestScore} | Mejor nota:{" "}
                                {assignment.bestScore ?? assignment.latestScore}
                                {latestAttemptDuration ? ` | Tiempo: ${latestAttemptDuration}` : ""}
                              </p>
                            ) : null}
                          </div>
                          {canToggle ? (
                            <button
                              type="button"
                              onClick={() =>
                                void handleToggleAssignment(assignment, !assignment.enabled)
                              }
                              className={`rounded-lg px-3 py-2 text-sm font-medium ${
                                assignment.enabled
                                  ? "border border-rose-200 bg-white text-rose-700"
                                  : "border border-emerald-200 bg-white text-emerald-700"
                              }`}
                            >
                              {assignment.enabled ? "Deshabilitar" : "Habilitar"}
                            </button>
                          ) : null}
                        </div>
                        <div className="mt-3 grid gap-2 text-xs text-slate-500 sm:grid-cols-2">
                          <span>Plantel: {assignment.plantelName || assignment.plantelId || "Sin plantel"}</span>
                          <span>Alumno: {assignment.studentEmail || assignment.studentId}</span>
                          <span>Plantilla: {assignment.templateTitle}</span>
                          <span>Pago verificado: {assignment.paymentVerifiedAt ? "Si" : "No"}</span>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        ) : null}
      </div>
    </RoleGate>
  );
}
