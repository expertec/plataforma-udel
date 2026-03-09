"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  setDoc,
  writeBatch,
  where,
} from "firebase/firestore";
import toast from "react-hot-toast";
import { jsPDF } from "jspdf";
import { db } from "@/lib/firebase/firestore";
import { auth } from "@/lib/firebase/client";
import { Submission, getAllSubmissions } from "@/lib/firebase/submissions-service";
import { UserRole, isAdminTeacherRole } from "@/lib/firebase/roles";

type CalificacionesTabProps = {
  groupId: string;
  courses: Array<{ courseId: string; courseName: string }>;
  groupTeacherId: string;
  currentUserId: string | null;
  userRole: UserRole | null;
  canManageClosuresOverride?: boolean;
  onCourseCompletedAndUnlinked?: (courseId: string) => Promise<void> | void;
};

type Student = { id: string; name: string };

type Task = {
  id: string;
  title: string;
};

type CourseClosureState = {
  status?: "open" | "closed";
  finalGrade?: number;
  autoGrade?: number | null;
  manualOverride?: boolean;
  pendingUngradedCount?: number;
  lastFinalGradeNotifiedAt?: Date | null;
  lastFinalGradeNotifiedBy?: string;
  lastFinalGradeNotifiedValue?: number;
  closedAt?: Date | null;
  closedById?: string;
  closedByName?: string;
  reopenedAt?: Date | null;
  reopenedById?: string;
  reopenedByName?: string;
  updatedAt?: Date | null;
};

type EnrollmentRecord = {
  id: string;
  courseClosures: Record<string, CourseClosureState>;
  studentName?: string;
};

type StudentCourseRow = {
  studentId: string;
  studentName: string;
  enrollmentId: string;
  autoGrade: number | null;
  pendingUngradedCount: number;
  gradedCount: number;
  totalEvaluable: number;
  closure: CourseClosureState | null;
};

type ClosureDocumentRow = {
  studentId: string;
  studentName: string;
  autoGrade: number | null;
  finalGrade: number;
  pendingUngradedCount: number;
  totalEvaluable: number;
};

type SignatureModalContext = {
  scope: "single" | "all";
  courseId: string;
  courseName: string;
  rows: ClosureDocumentRow[];
  requestedAt: Date;
};

type SignatureResult = {
  signerName: string;
  signedAt: Date;
  signatureDataUrl: string;
  context: SignatureModalContext;
};

type ConfirmationModalContext = {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "warning" | "danger";
};

const toDateOrNull = (value: unknown): Date | null => {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === "object" && value !== null && "toDate" in value) {
    const fn = (value as { toDate?: () => Date }).toDate;
    if (typeof fn === "function") {
      try {
        return fn();
      } catch {
        return null;
      }
    }
  }
  return null;
};

const formatDate = (value?: Date | null) => {
  if (!value) return "";
  return new Intl.DateTimeFormat("es-MX", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(value);
};

const formatDateTime = (value?: Date | null) => {
  if (!value) return "";
  return new Intl.DateTimeFormat("es-MX", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
};

export function CalificacionesTab({
  groupId,
  courses,
  groupTeacherId,
  currentUserId,
  userRole,
  canManageClosuresOverride,
  onCourseCompletedAndUnlinked,
}: CalificacionesTabProps) {
  const [students, setStudents] = useState<Student[]>([]);
  const [tasksByCourse, setTasksByCourse] = useState<Record<string, Task[]>>({});
  const [allSubmissions, setAllSubmissions] = useState<Submission[]>([]);
  const [enrollmentByStudent, setEnrollmentByStudent] = useState<Record<string, EnrollmentRecord>>({});
  const [selectedCourseId, setSelectedCourseId] = useState<string>(courses[0]?.courseId ?? "");
  const [draftFinalGrades, setDraftFinalGrades] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [processingStudentId, setProcessingStudentId] = useState<string | null>(null);
  const [processingNotifyStudentId, setProcessingNotifyStudentId] = useState<string | null>(null);
  const [processingAll, setProcessingAll] = useState(false);
  const [signatureModalContext, setSignatureModalContext] = useState<SignatureModalContext | null>(null);
  const [signerNameInput, setSignerNameInput] = useState("");
  const [signatureError, setSignatureError] = useState<string | null>(null);
  const [hasSignatureStroke, setHasSignatureStroke] = useState(false);
  const [confirmationModalContext, setConfirmationModalContext] = useState<ConfirmationModalContext | null>(null);

  const signatureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingSignatureRef = useRef(false);
  const signatureLastPointRef = useRef<{ x: number; y: number } | null>(null);
  const signatureModalResolverRef = useRef<((value: SignatureResult | null) => void) | null>(null);
  const confirmationModalResolverRef = useRef<((value: boolean) => void) | null>(null);
  const pdfBackgroundDataUrlRef = useRef<string | null>(null);

  const canManageClosures = useMemo(() => {
    if (typeof canManageClosuresOverride === "boolean") return canManageClosuresOverride;
    if (!currentUserId) return false;
    return currentUserId === groupTeacherId || isAdminTeacherRole(userRole);
  }, [canManageClosuresOverride, currentUserId, groupTeacherId, userRole]);

  useEffect(() => {
    if (!selectedCourseId && courses.length > 0) {
      setSelectedCourseId(courses[0].courseId);
      return;
    }
    if (selectedCourseId && courses.length > 0 && !courses.some((course) => course.courseId === selectedCourseId)) {
      setSelectedCourseId(courses[0].courseId);
    }
  }, [courses, selectedCourseId]);

  const selectedCourse = useMemo(
    () => courses.find((course) => course.courseId === selectedCourseId) ?? null,
    [courses, selectedCourseId],
  );

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      try {
        const studentsSnap = await getDocs(collection(db, "groups", groupId, "students"));
        const nextStudents = studentsSnap.docs.map((d) => ({
          id: d.id,
          name: d.data().studentName ?? "",
        }));

        const submissions = await getAllSubmissions(groupId);

        const enrollmentsSnap = await getDocs(
          query(collection(db, "studentEnrollments"), where("groupId", "==", groupId)),
        );

        const enrollmentsMap: Record<string, EnrollmentRecord> = {};
        enrollmentsSnap.docs.forEach((enrollmentDoc) => {
          const data = enrollmentDoc.data() as {
            studentId?: string;
            studentName?: string;
            courseClosures?: Record<string, unknown>;
            [key: string]: unknown;
          };
          const idFromDoc = enrollmentDoc.id.startsWith(`${groupId}_`)
            ? enrollmentDoc.id.slice(groupId.length + 1).trim()
            : "";
          const studentId =
            (typeof data.studentId === "string" ? data.studentId.trim() : "") || idFromDoc;
          if (!studentId) return;
          const canonicalId = `${groupId}_${studentId}`;
          const existing = enrollmentsMap[studentId];
          if (existing && existing.id === canonicalId) return;

          const rawClosures: Record<string, unknown> = {
            ...((data.courseClosures ?? {}) as Record<string, unknown>),
          };
          Object.entries(data).forEach(([key, value]) => {
            if (!key.startsWith("courseClosures.")) return;
            const legacyCourseId = key.slice("courseClosures.".length).trim();
            if (!legacyCourseId) return;
            if (!Object.prototype.hasOwnProperty.call(rawClosures, legacyCourseId)) {
              rawClosures[legacyCourseId] = value;
            }
          });
          const normalizedClosures: Record<string, CourseClosureState> = {};
          Object.entries(rawClosures).forEach(([courseId, closureValue]) => {
            if (!closureValue || typeof closureValue !== "object") return;
            const closureObj = closureValue as Record<string, unknown>;
            normalizedClosures[courseId] = {
              status:
                closureObj.status === "closed" || closureObj.status === "open"
                  ? (closureObj.status as "closed" | "open")
                  : undefined,
              finalGrade:
                typeof closureObj.finalGrade === "number" && Number.isFinite(closureObj.finalGrade)
                  ? closureObj.finalGrade
                  : undefined,
              autoGrade:
                typeof closureObj.autoGrade === "number" && Number.isFinite(closureObj.autoGrade)
                  ? closureObj.autoGrade
                  : null,
              manualOverride: closureObj.manualOverride === true,
              pendingUngradedCount:
                typeof closureObj.pendingUngradedCount === "number"
                  ? closureObj.pendingUngradedCount
                  : undefined,
              lastFinalGradeNotifiedAt: toDateOrNull(closureObj.lastFinalGradeNotifiedAt),
              lastFinalGradeNotifiedBy:
                typeof closureObj.lastFinalGradeNotifiedBy === "string"
                  ? closureObj.lastFinalGradeNotifiedBy
                  : undefined,
              lastFinalGradeNotifiedValue:
                typeof closureObj.lastFinalGradeNotifiedValue === "number" &&
                Number.isFinite(closureObj.lastFinalGradeNotifiedValue)
                  ? closureObj.lastFinalGradeNotifiedValue
                  : undefined,
              closedAt: toDateOrNull(closureObj.closedAt),
              closedById: typeof closureObj.closedById === "string" ? closureObj.closedById : undefined,
              closedByName:
                typeof closureObj.closedByName === "string" ? closureObj.closedByName : undefined,
              reopenedAt: toDateOrNull(closureObj.reopenedAt),
              reopenedById:
                typeof closureObj.reopenedById === "string" ? closureObj.reopenedById : undefined,
              reopenedByName:
                typeof closureObj.reopenedByName === "string" ? closureObj.reopenedByName : undefined,
              updatedAt: toDateOrNull(closureObj.updatedAt),
            };
          });

          const record: EnrollmentRecord = {
            id: enrollmentDoc.id,
            courseClosures: normalizedClosures,
            studentName: data.studentName,
          };

          if (!existing || enrollmentDoc.id === canonicalId) {
            enrollmentsMap[studentId] = record;
          }
        });

        const courseTasksEntries = await Promise.all(
          courses.map(async (course) => {
            const lessonsSnap = await getDocs(
              query(collection(db, "courses", course.courseId, "lessons"), orderBy("order", "asc")),
            );
            const tasks: Task[] = [];
            for (const lesson of lessonsSnap.docs) {
              const classesSnap = await getDocs(
                query(
                  collection(db, "courses", course.courseId, "lessons", lesson.id, "classes"),
                  orderBy("order", "asc"),
                ),
              );
              classesSnap.forEach((cls) => {
                const data = cls.data() as { type?: string; hasAssignment?: boolean; title?: string };
                const evaluable = data.type === "quiz" || data.hasAssignment === true;
                if (!evaluable) return;
                tasks.push({
                  id: cls.id,
                  title: data.title ?? "Sin título",
                });
              });
            }
            return [course.courseId, tasks] as const;
          }),
        );

        if (cancelled) return;
        setStudents(nextStudents);
        setAllSubmissions(submissions);
        setEnrollmentByStudent(enrollmentsMap);
        setTasksByCourse(Object.fromEntries(courseTasksEntries));
      } catch (err) {
        console.error(err);
        toast.error("No se pudieron cargar las calificaciones");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [courses, groupId]);

  const selectedCourseTasks = useMemo(() => {
    if (!selectedCourseId) return [];
    return tasksByCourse[selectedCourseId] ?? [];
  }, [selectedCourseId, tasksByCourse]);

  const rows = useMemo<StudentCourseRow[]>(() => {
    if (!selectedCourseId) return [];
    const classIdSet = new Set(selectedCourseTasks.map((t) => t.id));

    return students.map((student) => {
      const latestByClass = new Map<string, Submission>();
      allSubmissions.forEach((submission) => {
        if (submission.studentId !== student.id) return;
        if ((submission.courseId ?? "") !== selectedCourseId) return;
        const classId = (submission.classDocId ?? submission.classId ?? "").trim();
        if (!classId || !classIdSet.has(classId)) return;
        if (latestByClass.has(classId)) return;
        latestByClass.set(classId, submission);
      });

      const latestSubmissions = Array.from(latestByClass.values());
      const gradedSubmissions = latestSubmissions.filter(
        (sub) => sub.status === "graded" || typeof sub.grade === "number",
      );
      const gradedWithNumericGrade = gradedSubmissions.filter(
        (sub) => typeof sub.grade === "number",
      );
      const autoGrade =
        gradedWithNumericGrade.length > 0
          ? gradedWithNumericGrade.reduce((acc, item) => acc + (item.grade ?? 0), 0) / gradedWithNumericGrade.length
          : null;
      const pendingUngradedCount = Math.max(selectedCourseTasks.length - gradedSubmissions.length, 0);

      const enrollment = enrollmentByStudent[student.id];
      const closure = enrollment?.courseClosures?.[selectedCourseId] ?? null;

      return {
        studentId: student.id,
        studentName: student.name,
        enrollmentId: enrollment?.id ?? `${groupId}_${student.id}`,
        autoGrade,
        pendingUngradedCount,
        gradedCount: gradedSubmissions.length,
        totalEvaluable: selectedCourseTasks.length,
        closure,
      };
    });
  }, [allSubmissions, enrollmentByStudent, groupId, selectedCourseId, selectedCourseTasks, students]);

  const openRowsCount = useMemo(
    () => rows.filter((row) => row.closure?.status !== "closed").length,
    [rows],
  );

  const getDraftKey = (studentId: string) => `${selectedCourseId}::${studentId}`;

  const getFinalGradeInput = (row: StudentCourseRow) => {
    const key = getDraftKey(row.studentId);
    if (Object.prototype.hasOwnProperty.call(draftFinalGrades, key)) {
      return draftFinalGrades[key];
    }
    if (typeof row.closure?.finalGrade === "number") {
      return row.closure.finalGrade.toFixed(1);
    }
    if (typeof row.autoGrade === "number") {
      return row.autoGrade.toFixed(1);
    }
    return "";
  };

  const upsertLocalClosure = (
    studentId: string,
    courseId: string,
    closure: CourseClosureState,
    enrollmentId: string,
  ) => {
    setEnrollmentByStudent((prev) => {
      const current = prev[studentId] ?? { id: enrollmentId, courseClosures: {} };
      return {
        ...prev,
        [studentId]: {
          ...current,
          id: enrollmentId,
          courseClosures: {
            ...current.courseClosures,
            [courseId]: closure,
          },
        },
      };
    });
  };

  const initializeSignatureCanvas = () => {
    const canvas = signatureCanvasRef.current;
    if (!canvas || typeof window === "undefined") return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(rect.width * ratio);
    canvas.height = Math.floor(rect.height * ratio);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.strokeStyle = "#0f172a";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
  };

  const clearSignatureCanvas = () => {
    initializeSignatureCanvas();
    drawingSignatureRef.current = false;
    signatureLastPointRef.current = null;
    setHasSignatureStroke(false);
    setSignatureError(null);
  };

  const getCanvasPoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = signatureCanvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  };

  const handleSignaturePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const canvas = signatureCanvasRef.current;
    const ctx = canvas?.getContext("2d");
    const point = getCanvasPoint(event);
    if (!canvas || !ctx || !point) return;
    drawingSignatureRef.current = true;
    signatureLastPointRef.current = point;
    canvas.setPointerCapture(event.pointerId);
    ctx.beginPath();
    ctx.moveTo(point.x, point.y);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    setHasSignatureStroke(true);
    setSignatureError(null);
  };

  const handleSignaturePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingSignatureRef.current) return;
    event.preventDefault();
    const ctx = signatureCanvasRef.current?.getContext("2d");
    const point = getCanvasPoint(event);
    const previous = signatureLastPointRef.current;
    if (!ctx || !point || !previous) return;
    ctx.beginPath();
    ctx.moveTo(previous.x, previous.y);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    signatureLastPointRef.current = point;
    setHasSignatureStroke(true);
  };

  const handleSignaturePointerEnd = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingSignatureRef.current) return;
    event.preventDefault();
    drawingSignatureRef.current = false;
    signatureLastPointRef.current = null;
  };

  const resolveSignatureModal = (value: SignatureResult | null) => {
    const resolver = signatureModalResolverRef.current;
    signatureModalResolverRef.current = null;
    setSignatureModalContext(null);
    setSignerNameInput("");
    setSignatureError(null);
    setHasSignatureStroke(false);
    drawingSignatureRef.current = false;
    signatureLastPointRef.current = null;
    resolver?.(value);
  };

  const requestDigitalSignature = (context: SignatureModalContext) =>
    new Promise<SignatureResult | null>((resolve) => {
      signatureModalResolverRef.current = resolve;
      setSignerNameInput("");
      setSignatureError(null);
      setHasSignatureStroke(false);
      drawingSignatureRef.current = false;
      signatureLastPointRef.current = null;
      setSignatureModalContext(context);
    });

  const resolveConfirmationModal = (accepted: boolean) => {
    const resolver = confirmationModalResolverRef.current;
    confirmationModalResolverRef.current = null;
    setConfirmationModalContext(null);
    resolver?.(accepted);
  };

  const requestConfirmation = (context: ConfirmationModalContext) =>
    new Promise<boolean>((resolve) => {
      confirmationModalResolverRef.current = resolve;
      setConfirmationModalContext(context);
    });

  const confirmDigitalSignature = () => {
    if (!signatureModalContext) return;
    const signerName = signerNameInput.trim();
    if (signerName.length < 3) {
      setSignatureError("Escribe tu nombre completo para firmar.");
      return;
    }
    if (!hasSignatureStroke) {
      setSignatureError("Agrega tu firma en el recuadro.");
      return;
    }
    const canvas = signatureCanvasRef.current;
    if (!canvas) {
      setSignatureError("No se pudo leer la firma, intenta nuevamente.");
      return;
    }
    resolveSignatureModal({
      signerName,
      signedAt: new Date(),
      signatureDataUrl: canvas.toDataURL("image/png"),
      context: signatureModalContext,
    });
  };

  const loadPdfBackgroundDataUrl = async (): Promise<string | null> => {
    if (pdfBackgroundDataUrlRef.current) return pdfBackgroundDataUrlRef.current;
    try {
      const response = await fetch("/bg-pdf-01.png", { cache: "force-cache" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const blob = await response.blob();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          if (typeof reader.result === "string") {
            resolve(reader.result);
            return;
          }
          reject(new Error("No se pudo convertir el fondo del PDF"));
        };
        reader.onerror = () => reject(new Error("No se pudo leer el fondo del PDF"));
        reader.readAsDataURL(blob);
      });
      pdfBackgroundDataUrlRef.current = dataUrl;
      return dataUrl;
    } catch (error) {
      console.error("No se pudo cargar bg-pdf-01.png para el PDF:", error);
      return null;
    }
  };

  const downloadSignedClosurePdf = async (signature: SignatureResult) => {
    const pdf = new jsPDF({ unit: "pt", format: "a4" });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const contentWidth = Math.min(460, pageWidth - 120);
    const marginX = (pageWidth - contentWidth) / 2;
    const bottomLimit = pageHeight - 132;
    const topStart = 130;
    let y = topStart;
    const bgImage = await loadPdfBackgroundDataUrl();

    const rows = signature.context.rows;
    const avgFinalGrade =
      rows.length > 0
        ? rows.reduce((acc, row) => acc + row.finalGrade, 0) / rows.length
        : 0;
    const columns = {
      student: marginX + 2,
      auto: marginX + 300,
      final: marginX + 348,
      pending: marginX + 406,
    };

    const drawPageBackground = () => {
      if (bgImage) {
        pdf.addImage(bgImage, "PNG", 0, 0, pageWidth, pageHeight);
      }
    };

    const drawTopHeader = () => {
      pdf.setTextColor(124, 21, 45);
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(22);
      pdf.text("Acta de Cierre de Calificaciones", pageWidth / 2, y, { align: "center" });
      y += 14;
      pdf.setDrawColor(124, 21, 45);
      pdf.setLineWidth(1);
      pdf.line(marginX, y, marginX + contentWidth, y);
      pdf.setTextColor(15, 23, 42);
      y += 20;
    };

    const drawMetaSection = () => {
      const metaRows = [
        { label: "Materia:", value: signature.context.courseName },
        { label: "Docente firmante:", value: signature.signerName },
        { label: "Fecha y hora de firma:", value: formatDateTime(signature.signedAt) },
        { label: "Grupo academico:", value: "asignado en plataforma" },
      ];
      const labelWidth = 184;
      const valueX = marginX + labelWidth;
      const valueWidth = contentWidth - labelWidth - 4;

      pdf.setFontSize(12);
      metaRows.forEach((item) => {
        const valueLines = pdf.splitTextToSize(item.value, valueWidth) as string[];
        const rowHeight = Math.max(16, valueLines.length * 14);
        pdf.setFont("helvetica", "bold");
        pdf.text(item.label, marginX, y);
        pdf.setFont("helvetica", "normal");
        pdf.text(valueLines, valueX, y);
        y += rowHeight + 4;
      });

      y += 4;
    };

    const drawSummaryRow = () => {
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(12);
      pdf.text(`Alumnos incluidos: ${rows.length}`, marginX, y);
      pdf.text(`Promedio final: ${avgFinalGrade.toFixed(1)}`, marginX + contentWidth, y, { align: "right" });
      y += 14;
      pdf.setDrawColor(203, 213, 225);
      pdf.setLineWidth(0.8);
      pdf.line(marginX, y, marginX + contentWidth, y);
      y += 16;
    };

    const drawTableHeader = () => {
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(11);
      pdf.text("Alumno", columns.student, y);
      pdf.text("Auto", columns.auto, y);
      pdf.text("Final", columns.final, y);
      pdf.text("Pendientes", columns.pending, y);
      y += 8;
      pdf.setDrawColor(148, 163, 184);
      pdf.setLineWidth(0.9);
      pdf.line(marginX, y, marginX + contentWidth, y);
      y += 16;
    };

    const startNewPage = (withTableHeader = false) => {
      pdf.addPage();
      drawPageBackground();
      y = topStart;
      drawTopHeader();
      if (withTableHeader) {
        drawTableHeader();
      }
    };

    const ensureSpace = (required: number, withTableHeader = false) => {
      if (y + required <= bottomLimit) return;
      startNewPage(withTableHeader);
    };

    drawPageBackground();
    drawTopHeader();
    drawMetaSection();
    drawSummaryRow();
    drawTableHeader();

    rows.forEach((row, index) => {
      const studentName = `${index + 1}. ${row.studentName || "Alumno sin nombre"}`;
      const nameLines = pdf.splitTextToSize(studentName, 270) as string[];
      const rowHeight = Math.max(24, nameLines.length * 12 + 6);
      ensureSpace(rowHeight + 12, true);

      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(11);
      pdf.text(nameLines, columns.student, y);
      pdf.text(typeof row.autoGrade === "number" ? row.autoGrade.toFixed(1) : "—", columns.auto, y);
      pdf.text(row.finalGrade.toFixed(1), columns.final, y);
      pdf.text(`${row.pendingUngradedCount}/${row.totalEvaluable}`, columns.pending, y);

      y += rowHeight;
      pdf.setDrawColor(226, 232, 240);
      pdf.setLineWidth(0.7);
      pdf.line(marginX, y, marginX + contentWidth, y);
      y += 10;
    });

    ensureSpace(210, false);

    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(14);
    pdf.text("Firma digital del docente", marginX, y);

    y += 12;
    pdf.setDrawColor(148, 163, 184);
    pdf.setLineWidth(0.9);
    pdf.line(marginX, y, marginX + contentWidth, y);

    const signatureBlockTop = y + 18;
    const signatureLineWidth = 280;
    const signatureLineY = signatureBlockTop + 64;

    pdf.setDrawColor(120, 120, 120);
    pdf.setLineWidth(0.85);
    pdf.line(marginX, signatureLineY, marginX + signatureLineWidth, signatureLineY);

    pdf.addImage(
      signature.signatureDataUrl,
      "PNG",
      marginX + 14,
      signatureLineY - 58,
      signatureLineWidth - 28,
      56,
    );

    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(10);
    pdf.setTextColor(71, 85, 105);
    pdf.text("Firma del docente", marginX, signatureLineY + 14);

    const legalX = marginX + signatureLineWidth + 18;
    const legalWidth = contentWidth - signatureLineWidth - 18;
    const legalLineHeight = 14;
    pdf.setFontSize(12);
    pdf.setTextColor(15, 23, 42);
    const legalText = pdf.splitTextToSize(
      "Con esta firma se valida el cierre de calificaciones mostrado en este documento.",
      legalWidth,
    ) as string[];
    pdf.text(legalText, legalX, signatureBlockTop + 12);
    const legalBottomY = signatureBlockTop + 12 + Math.max(0, (legalText.length - 1) * legalLineHeight);
    const registeredLabelY = legalBottomY + 24;
    pdf.text("Fecha de registro:", legalX, registeredLabelY);
    pdf.setFont("helvetica", "bold");
    const registeredValueY = registeredLabelY + 16;
    pdf.text(formatDateTime(signature.signedAt), legalX, registeredValueY);

    const signerNameY = signatureLineY + 38;
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(15);
    pdf.text(signature.signerName, marginX, signerNameY);

    y = Math.max(signerNameY + 18, registeredValueY + 18);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(11);
    pdf.setTextColor(71, 85, 105);
    pdf.text("Documento generado por Plataforma UDEL.", marginX, y);

    const safeCourseName = signature.context.courseName
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();
    const stamp = signature.signedAt
      .toISOString()
      .slice(0, 16)
      .replace("T", "-")
      .replace(":", "");
    const fileName = `acta-cierre-${safeCourseName || "materia"}-${stamp}.pdf`;
    pdf.save(fileName);
  };

  useEffect(() => {
    if (!signatureModalContext) return;
    const timer = window.setTimeout(() => {
      initializeSignatureCanvas();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [signatureModalContext]);

  useEffect(() => {
    return () => {
      signatureModalResolverRef.current?.(null);
      signatureModalResolverRef.current = null;
      confirmationModalResolverRef.current?.(false);
      confirmationModalResolverRef.current = null;
    };
  }, []);

  const handleCloseCourseForStudent = async (row: StudentCourseRow) => {
    if (!selectedCourseId) return;
    if (processingAll) return;
    if (processingNotifyStudentId === row.studentId) return;
    if (!canManageClosures || !currentUserId) {
      toast.error("No tienes permisos para cerrar materias.");
      return;
    }

    const rawGrade = getFinalGradeInput(row).trim();
    const finalGrade = Number(rawGrade);
    if (!Number.isFinite(finalGrade) || finalGrade < 0 || finalGrade > 100) {
      toast.error("La calificación final debe estar entre 0 y 100.");
      return;
    }

    if (row.pendingUngradedCount > 0) {
      const confirmed = await requestConfirmation({
        title: "Actividades pendientes",
        message:
          `Este alumno tiene ${row.pendingUngradedCount} actividades sin calificar. ` +
          "¿Deseas cerrar de todas formas?",
        confirmLabel: "Cerrar de todas formas",
        cancelLabel: "Cancelar",
        tone: "warning",
      });
      if (!confirmed) return;
    }

    const selectedCourseName = selectedCourse?.courseName ?? "Materia";
    const signature = await requestDigitalSignature({
      scope: "single",
      courseId: selectedCourseId,
      courseName: selectedCourseName,
      requestedAt: new Date(),
      rows: [
        {
          studentId: row.studentId,
          studentName: row.studentName,
          autoGrade: row.autoGrade,
          finalGrade,
          pendingUngradedCount: row.pendingUngradedCount,
          totalEvaluable: row.totalEvaluable,
        },
      ],
    });
    if (!signature) return;

    setProcessingStudentId(row.studentId);
    try {
      const previousClosure = row.closure ?? null;
      const manualOverride =
        row.autoGrade === null ? true : Math.abs(finalGrade - row.autoGrade) > 0.01;
      const closurePayload: CourseClosureState = {
        status: "closed",
        finalGrade,
        autoGrade: row.autoGrade,
        manualOverride,
        pendingUngradedCount: row.pendingUngradedCount,
        lastFinalGradeNotifiedAt: previousClosure?.lastFinalGradeNotifiedAt ?? null,
        lastFinalGradeNotifiedBy: previousClosure?.lastFinalGradeNotifiedBy,
        lastFinalGradeNotifiedValue: previousClosure?.lastFinalGradeNotifiedValue,
        closedAt: new Date(),
        closedById: currentUserId,
        closedByName: signature.signerName,
        updatedAt: new Date(),
      };

      const enrollmentRef = doc(db, "studentEnrollments", row.enrollmentId);
      await setDoc(
        enrollmentRef,
        {
          studentId: row.studentId,
          studentName: row.studentName,
          groupId,
          courseClosures: {
            [selectedCourseId]: {
              status: closurePayload.status,
              finalGrade: closurePayload.finalGrade,
              autoGrade: closurePayload.autoGrade,
              manualOverride: closurePayload.manualOverride,
              pendingUngradedCount: closurePayload.pendingUngradedCount,
              lastFinalGradeNotifiedAt: closurePayload.lastFinalGradeNotifiedAt ?? null,
              lastFinalGradeNotifiedBy: closurePayload.lastFinalGradeNotifiedBy ?? null,
              lastFinalGradeNotifiedValue: closurePayload.lastFinalGradeNotifiedValue ?? null,
              closedAt: closurePayload.closedAt,
              closedById: closurePayload.closedById,
              closedByName: closurePayload.closedByName,
              updatedAt: closurePayload.updatedAt,
            },
          },
        },
        { merge: true },
      );

      upsertLocalClosure(row.studentId, selectedCourseId, closurePayload, row.enrollmentId);
      await downloadSignedClosurePdf(signature);
      toast.success(`Materia cerrada para ${row.studentName}`);
    } catch (err) {
      console.error(err);
      toast.error("No se pudo cerrar la materia para este alumno.");
    } finally {
      setProcessingStudentId(null);
    }
  };

  const handleSaveAndNotifyFinalGradeForStudent = async (row: StudentCourseRow) => {
    if (!selectedCourseId) return;
    if (processingAll) return;
    if (!canManageClosures || !currentUserId) {
      toast.error("No tienes permisos para calificar materias.");
      return;
    }

    const rawGrade = getFinalGradeInput(row).trim();
    const finalGrade = Number(rawGrade);
    if (!Number.isFinite(finalGrade) || finalGrade < 0 || finalGrade > 100) {
      toast.error("La calificación final debe estar entre 0 y 100.");
      return;
    }

    setProcessingNotifyStudentId(row.studentId);
    let gradeSaved = false;
    try {
      const now = new Date();
      const manualOverride =
        row.autoGrade === null ? true : Math.abs(finalGrade - row.autoGrade) > 0.01;
      const previousClosure = row.closure ?? null;
      const isClosed = previousClosure?.status === "closed";
      const payload: CourseClosureState = {
        status: isClosed ? "closed" : "open",
        finalGrade,
        autoGrade: row.autoGrade,
        manualOverride,
        pendingUngradedCount: row.pendingUngradedCount,
        lastFinalGradeNotifiedAt: previousClosure?.lastFinalGradeNotifiedAt ?? null,
        lastFinalGradeNotifiedBy: previousClosure?.lastFinalGradeNotifiedBy,
        lastFinalGradeNotifiedValue: previousClosure?.lastFinalGradeNotifiedValue,
        closedAt: previousClosure?.closedAt ?? null,
        closedById: previousClosure?.closedById,
        closedByName: previousClosure?.closedByName,
        reopenedAt: previousClosure?.reopenedAt ?? null,
        reopenedById: previousClosure?.reopenedById,
        reopenedByName: previousClosure?.reopenedByName,
        updatedAt: now,
      };

      const enrollmentRef = doc(db, "studentEnrollments", row.enrollmentId);
      await setDoc(
        enrollmentRef,
        {
          studentId: row.studentId,
          studentName: row.studentName,
          groupId,
          courseClosures: {
            [selectedCourseId]: {
              status: payload.status,
              finalGrade: payload.finalGrade,
              autoGrade: payload.autoGrade,
              manualOverride: payload.manualOverride,
              pendingUngradedCount: payload.pendingUngradedCount,
              lastFinalGradeNotifiedAt: payload.lastFinalGradeNotifiedAt ?? null,
              lastFinalGradeNotifiedBy: payload.lastFinalGradeNotifiedBy ?? null,
              lastFinalGradeNotifiedValue: payload.lastFinalGradeNotifiedValue ?? null,
              closedAt: payload.closedAt ?? null,
              closedById: payload.closedById ?? null,
              closedByName: payload.closedByName ?? null,
              reopenedAt: payload.reopenedAt ?? null,
              reopenedById: payload.reopenedById ?? null,
              reopenedByName: payload.reopenedByName ?? null,
              updatedAt: payload.updatedAt,
            },
          },
        },
        { merge: true },
      );

      gradeSaved = true;
      upsertLocalClosure(row.studentId, selectedCourseId, payload, row.enrollmentId);
      const key = getDraftKey(row.studentId);
      setDraftFinalGrades((prev) => ({ ...prev, [key]: finalGrade.toFixed(1) }));

      const currentSessionUser = auth.currentUser;
      if (!currentSessionUser) {
        throw new Error("Tu sesión expiró. Inicia sesión nuevamente.");
      }
      const token = await currentSessionUser.getIdToken();
      const response = await fetch("/api/notifications/whatsapp/final-grade", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          groupId,
          studentId: row.studentId,
          courseId: selectedCourseId,
          finalGrade,
        }),
      });

      const data = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
        data?: { notified?: boolean; reason?: string };
      };

      if (!response.ok || data.success !== true) {
        throw new Error(data.error || "No se pudo notificar por WhatsApp");
      }

      if (data.data?.notified === false) {
        toast(
          `Calificación guardada para ${row.studentName}, pero WhatsApp no enviado: ${
            data.data.reason || "sin detalle"
          }`,
        );
      } else {
        const notifiedAt = new Date();
        const notifiedPayload: CourseClosureState = {
          ...payload,
          lastFinalGradeNotifiedAt: notifiedAt,
          lastFinalGradeNotifiedBy: currentUserId,
          lastFinalGradeNotifiedValue: finalGrade,
          updatedAt: notifiedAt,
        };

        await setDoc(
          enrollmentRef,
          {
            studentId: row.studentId,
            studentName: row.studentName,
            groupId,
            courseClosures: {
              [selectedCourseId]: {
                status: notifiedPayload.status,
                finalGrade: notifiedPayload.finalGrade,
                autoGrade: notifiedPayload.autoGrade,
                manualOverride: notifiedPayload.manualOverride,
                pendingUngradedCount: notifiedPayload.pendingUngradedCount,
                lastFinalGradeNotifiedAt: notifiedPayload.lastFinalGradeNotifiedAt,
                lastFinalGradeNotifiedBy: notifiedPayload.lastFinalGradeNotifiedBy,
                lastFinalGradeNotifiedValue: notifiedPayload.lastFinalGradeNotifiedValue,
                closedAt: notifiedPayload.closedAt ?? null,
                closedById: notifiedPayload.closedById ?? null,
                closedByName: notifiedPayload.closedByName ?? null,
                reopenedAt: notifiedPayload.reopenedAt ?? null,
                reopenedById: notifiedPayload.reopenedById ?? null,
                reopenedByName: notifiedPayload.reopenedByName ?? null,
                updatedAt: notifiedPayload.updatedAt,
              },
            },
          },
          { merge: true },
        );

        upsertLocalClosure(row.studentId, selectedCourseId, notifiedPayload, row.enrollmentId);
        toast.success(`Calificación guardada y notificada a ${row.studentName}`);
      }
    } catch (err) {
      console.error(err);
      const message =
        err instanceof Error ? err.message : "Error al guardar/notificar calificación";
      if (gradeSaved) {
        toast.error(`Calificación guardada, pero no se pudo notificar por WhatsApp: ${message}`);
      } else {
        toast.error(message);
      }
    } finally {
      setProcessingNotifyStudentId(null);
    }
  };

  const handleReopenCourseForStudent = async (row: StudentCourseRow) => {
    if (!selectedCourseId) return;
    if (processingAll) return;
    if (processingNotifyStudentId === row.studentId) return;
    if (!canManageClosures || !currentUserId) {
      toast.error("No tienes permisos para reabrir materias.");
      return;
    }

    const confirmed = await requestConfirmation({
      title: "Reabrir materia",
      message: `¿Reabrir la materia para ${row.studentName}?`,
      confirmLabel: "Sí, reabrir",
      cancelLabel: "Cancelar",
      tone: "default",
    });
    if (!confirmed) return;

    setProcessingStudentId(row.studentId);
    try {
      const previous = row.closure ?? null;
      const reopenPayload: CourseClosureState = {
        status: "open",
        finalGrade: previous?.finalGrade,
        autoGrade: previous?.autoGrade ?? row.autoGrade,
        manualOverride: previous?.manualOverride ?? false,
        pendingUngradedCount: row.pendingUngradedCount,
        lastFinalGradeNotifiedAt: previous?.lastFinalGradeNotifiedAt ?? null,
        lastFinalGradeNotifiedBy: previous?.lastFinalGradeNotifiedBy,
        lastFinalGradeNotifiedValue: previous?.lastFinalGradeNotifiedValue,
        closedAt: previous?.closedAt ?? null,
        closedById: previous?.closedById,
        closedByName: previous?.closedByName,
        reopenedAt: new Date(),
        reopenedById: currentUserId,
        reopenedByName: "Profesor",
        updatedAt: new Date(),
      };

      const enrollmentRef = doc(db, "studentEnrollments", row.enrollmentId);
      await setDoc(
        enrollmentRef,
        {
          studentId: row.studentId,
          studentName: row.studentName,
          groupId,
          courseClosures: {
            [selectedCourseId]: {
              status: reopenPayload.status,
              finalGrade: reopenPayload.finalGrade ?? null,
              autoGrade: reopenPayload.autoGrade ?? null,
              manualOverride: reopenPayload.manualOverride ?? false,
              pendingUngradedCount: reopenPayload.pendingUngradedCount,
              lastFinalGradeNotifiedAt: reopenPayload.lastFinalGradeNotifiedAt ?? null,
              lastFinalGradeNotifiedBy: reopenPayload.lastFinalGradeNotifiedBy ?? null,
              lastFinalGradeNotifiedValue: reopenPayload.lastFinalGradeNotifiedValue ?? null,
              closedAt: reopenPayload.closedAt ?? null,
              closedById: reopenPayload.closedById ?? null,
              closedByName: reopenPayload.closedByName ?? null,
              reopenedAt: reopenPayload.reopenedAt,
              reopenedById: reopenPayload.reopenedById,
              reopenedByName: reopenPayload.reopenedByName,
              updatedAt: reopenPayload.updatedAt,
            },
          },
        },
        { merge: true },
      );

      upsertLocalClosure(row.studentId, selectedCourseId, reopenPayload, row.enrollmentId);
      toast.success(`Materia reabierta para ${row.studentName}`);
    } catch (err) {
      console.error(err);
      toast.error("No se pudo reabrir la materia para este alumno.");
    } finally {
      setProcessingStudentId(null);
    }
  };

  const handleCloseCourseForAll = async () => {
    if (!selectedCourseId) return;
    if (processingNotifyStudentId !== null) {
      toast("Espera a que termine la notificación en curso.");
      return;
    }
    if (!canManageClosures || !currentUserId) {
      toast.error("No tienes permisos para cerrar materias.");
      return;
    }

    const openRows = rows.filter((row) => row.closure?.status !== "closed");
    if (!openRows.length) {
      toast("Todas las materias de esta selección ya están cerradas.");
      return;
    }

    const parsedRows = openRows.map((row) => {
      const rawGrade = getFinalGradeInput(row).trim();
      const finalGrade = Number(rawGrade);
      return { row, rawGrade, finalGrade };
    });

    const invalidRows = parsedRows.filter(
      ({ rawGrade, finalGrade }) =>
        rawGrade.length === 0 || !Number.isFinite(finalGrade) || finalGrade < 0 || finalGrade > 100,
    );
    if (invalidRows.length > 0) {
      toast.error(
        `Faltan calificaciones válidas (0..100) para ${invalidRows.length} alumno(s).`,
      );
      return;
    }

    const pendingStudents = openRows.filter((row) => row.pendingUngradedCount > 0);
    const pendingTotal = pendingStudents.reduce((acc, row) => acc + row.pendingUngradedCount, 0);
    if (pendingStudents.length > 0) {
      const confirmed = await requestConfirmation({
        title: "Hay actividades pendientes",
        message:
          `Hay ${pendingStudents.length} alumno(s) con actividades pendientes ` +
          `(${pendingTotal} en total). ¿Cerrar de todas formas para todos?`,
        confirmLabel: "Cerrar de todas formas",
        cancelLabel: "Cancelar",
        tone: "warning",
      });
      if (!confirmed) return;
    }

    const selectedCourseName = selectedCourse?.courseName ?? "esta materia";
    const confirmedAll = await requestConfirmation({
      title: "Cerrar calificaciones de la materia",
      message:
        `Vas a cerrar calificaciones de "${selectedCourseName}" para ${openRows.length} alumno(s). ` +
        "Al confirmar, la materia se marcará como completada y se retirará de tu carga docente en este grupo.",
      confirmLabel: "Sí, cerrar calificaciones",
      cancelLabel: "Cancelar",
      tone: "danger",
    });
    if (!confirmedAll) return;

    const signature = await requestDigitalSignature({
      scope: "all",
      courseId: selectedCourseId,
      courseName: selectedCourseName,
      requestedAt: new Date(),
      rows: parsedRows.map(({ row, finalGrade }) => ({
        studentId: row.studentId,
        studentName: row.studentName,
        autoGrade: row.autoGrade,
        finalGrade,
        pendingUngradedCount: row.pendingUngradedCount,
        totalEvaluable: row.totalEvaluable,
      })),
    });
    if (!signature) return;

    setProcessingAll(true);
    let processStage: "closing" | "unlinking" | "pdf" = "closing";
    try {
      const now = new Date();
      const chunkSize = 400;

      for (let i = 0; i < parsedRows.length; i += chunkSize) {
        const chunk = parsedRows.slice(i, i + chunkSize);
        const batch = writeBatch(db);
        chunk.forEach(({ row, finalGrade }) => {
          const manualOverride =
            row.autoGrade === null ? true : Math.abs(finalGrade - row.autoGrade) > 0.01;
          const previousClosure = row.closure ?? null;
          const enrollmentRef = doc(db, "studentEnrollments", row.enrollmentId);
          batch.set(
            enrollmentRef,
            {
              studentId: row.studentId,
              studentName: row.studentName,
              groupId,
              courseClosures: {
                [selectedCourseId]: {
                  status: "closed",
                  finalGrade,
                  autoGrade: row.autoGrade,
                  manualOverride,
                  pendingUngradedCount: row.pendingUngradedCount,
                  lastFinalGradeNotifiedAt: previousClosure?.lastFinalGradeNotifiedAt ?? null,
                  lastFinalGradeNotifiedBy: previousClosure?.lastFinalGradeNotifiedBy ?? null,
                  lastFinalGradeNotifiedValue: previousClosure?.lastFinalGradeNotifiedValue ?? null,
                  closedAt: now,
                  closedById: currentUserId,
                  closedByName: signature.signerName,
                  updatedAt: now,
                },
              },
            },
            { merge: true },
          );
        });
        await batch.commit();
      }

      setEnrollmentByStudent((prev) => {
        const next = { ...prev };
        parsedRows.forEach(({ row, finalGrade }) => {
          const manualOverride =
            row.autoGrade === null ? true : Math.abs(finalGrade - row.autoGrade) > 0.01;
          const previousClosure = row.closure ?? null;
          const current = next[row.studentId] ?? { id: row.enrollmentId, courseClosures: {} };
          next[row.studentId] = {
            ...current,
            id: row.enrollmentId,
            courseClosures: {
              ...current.courseClosures,
              [selectedCourseId]: {
                status: "closed",
                finalGrade,
                autoGrade: row.autoGrade,
                manualOverride,
                pendingUngradedCount: row.pendingUngradedCount,
                lastFinalGradeNotifiedAt: previousClosure?.lastFinalGradeNotifiedAt ?? null,
                lastFinalGradeNotifiedBy: previousClosure?.lastFinalGradeNotifiedBy,
                lastFinalGradeNotifiedValue: previousClosure?.lastFinalGradeNotifiedValue,
                closedAt: now,
                closedById: currentUserId,
                closedByName: signature.signerName,
                updatedAt: now,
              },
            },
          };
        });
        return next;
      });

      processStage = "unlinking";
      const currentSessionUser = auth.currentUser;
      if (!currentSessionUser) {
        throw new Error("Tu sesión expiró. Inicia sesión nuevamente.");
      }
      const token = await currentSessionUser.getIdToken();
      const response = await fetch("/api/groups/unlink-course", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          groupId,
          courseId: selectedCourseId,
          teacherId: currentUserId,
          scope: "teacher",
        }),
      });

      let data: { updated?: boolean; error?: string } | null = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }

      if (!response.ok) {
        throw new Error(data?.error || "No se pudo desvincular la materia del grupo");
      }

      const unlinked = Boolean(data?.updated);
      if (!unlinked) {
        throw new Error(data?.error || "No se aplicó la desvinculación del profesor para esta materia.");
      }
      await onCourseCompletedAndUnlinked?.(selectedCourseId);

      processStage = "pdf";
      await downloadSignedClosurePdf(signature);

      if (unlinked) {
        toast.success(`Materia cerrada para ${openRows.length} alumno(s) y retirada de tu carga docente.`);
      } else {
        toast.success(`Materia cerrada para ${openRows.length} alumno(s).`);
      }
    } catch (err) {
      console.error(err);
      const message = err instanceof Error ? err.message : "Error inesperado al procesar el cierre";
      if (processStage === "closing") {
        toast.error("No se pudo cerrar la materia para todos.");
      } else if (processStage === "unlinking") {
        toast.error(`Calificaciones cerradas, pero hubo un error al desvincular: ${message}. No se generó el PDF.`);
      } else {
        toast.error(`Calificaciones cerradas y desvinculadas, pero no se pudo generar el PDF: ${message}`);
      }
    } finally {
      setProcessingAll(false);
    }
  };

  if (!courses.length) {
    return (
      <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
        Este grupo no tiene materias asignadas.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
        Cargando calificaciones...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Materia</span>
          <select
            value={selectedCourseId}
            onChange={(e) => setSelectedCourseId(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
          >
            {courses.map((course) => (
              <option key={course.courseId} value={course.courseId}>
                {course.courseName}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          {canManageClosures ? (
            <button
              type="button"
              onClick={handleCloseCourseForAll}
              disabled={
                processingAll ||
                processingStudentId !== null ||
                processingNotifyStudentId !== null ||
                selectedCourseTasks.length === 0 ||
                rows.length === 0 ||
                openRowsCount === 0
              }
              className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
            >
              {processingAll ? "Cerrando..." : "Cerrar y completar"}
            </button>
          ) : null}
          <span className="text-xs text-slate-500">
            {canManageClosures
              ? "Puedes guardar/notificar calificación y cerrar o reabrir materia por alumno."
              : "Solo lectura: no tienes permiso para cerrar/reabrir."}
          </span>
        </div>
      </div>

      {selectedCourseTasks.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
          Esta materia no tiene actividades evaluables (quiz/tarea).
        </div>
      ) : (
        <div className="overflow-auto rounded-lg border border-slate-200">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="px-3 py-2 text-left">Alumno</th>
                <th className="px-3 py-2 text-left">Auto</th>
                <th className="px-3 py-2 text-left">Final</th>
                <th className="px-3 py-2 text-left">Pendientes</th>
                <th className="px-3 py-2 text-left">Estado</th>
                <th className="px-3 py-2 text-left">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.length === 0 ? (
                <tr>
                  <td className="px-3 py-4 text-center text-slate-500" colSpan={6}>
                    No hay alumnos en este grupo.
                  </td>
                </tr>
              ) : rows.map((row) => {
                const isClosed = row.closure?.status === "closed";
                const finalInput = getFinalGradeInput(row);
                const finalGradeNum = Number(finalInput);
                const invalidFinal =
                  finalInput.trim().length > 0 &&
                  (!Number.isFinite(finalGradeNum) || finalGradeNum < 0 || finalGradeNum > 100);
                const isRowProcessing =
                  processingAll ||
                  processingStudentId === row.studentId ||
                  processingNotifyStudentId === row.studentId;

                return (
                  <tr key={row.studentId} className="hover:bg-slate-50">
                    <td className="px-3 py-2 text-slate-900">{row.studentName || "Sin nombre"}</td>
                    <td className="px-3 py-2 text-slate-700">
                      {typeof row.autoGrade === "number" ? row.autoGrade.toFixed(1) : "—"}
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={0.1}
                        value={finalInput}
                        onChange={(e) => {
                          const key = getDraftKey(row.studentId);
                          setDraftFinalGrades((prev) => ({ ...prev, [key]: e.target.value }));
                        }}
                        disabled={!canManageClosures || isRowProcessing}
                        className={`w-28 rounded-lg border px-2 py-1 text-sm ${
                          invalidFinal ? "border-red-400" : "border-slate-300"
                        } ${!canManageClosures ? "bg-slate-100 text-slate-500" : "bg-white text-slate-900"}`}
                      />
                    </td>
                    <td className="px-3 py-2 text-slate-700">
                      {row.pendingUngradedCount} / {row.totalEvaluable}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col gap-1">
                        <span
                          className={`inline-flex w-fit rounded-full px-2 py-1 text-xs font-semibold ${
                            isClosed
                              ? "bg-emerald-100 text-emerald-700"
                              : "bg-amber-100 text-amber-700"
                          }`}
                        >
                          {isClosed ? "Cerrada" : "Abierta"}
                        </span>
                        {isClosed && row.closure?.closedAt ? (
                          <span className="text-[11px] text-slate-500">
                            Cierre: {formatDate(row.closure.closedAt)}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {isClosed ? (
                        <button
                          type="button"
                          disabled={!canManageClosures || isRowProcessing}
                          onClick={() => handleReopenCourseForStudent(row)}
                          className="rounded-lg border border-amber-300 px-3 py-1 text-xs font-semibold text-amber-700 hover:bg-amber-50 disabled:opacity-60"
                        >
                          {isRowProcessing ? "Procesando..." : "Reabrir"}
                        </button>
                      ) : (
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            disabled={
                              !canManageClosures ||
                              isRowProcessing ||
                              finalInput.trim().length === 0 ||
                              invalidFinal
                            }
                            onClick={() => handleSaveAndNotifyFinalGradeForStudent(row)}
                            className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-60"
                          >
                            {processingNotifyStudentId === row.studentId
                              ? "Notificando..."
                              : "Guardar y notificar"}
                          </button>
                          <button
                            type="button"
                            disabled={
                              !canManageClosures ||
                              isRowProcessing ||
                              finalInput.trim().length === 0 ||
                              invalidFinal
                            }
                            onClick={() => handleCloseCourseForStudent(row)}
                            className="rounded-lg bg-blue-600 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-60"
                          >
                            {processingStudentId === row.studentId ? "Procesando..." : "Cerrar"}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {signatureModalContext ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/55 px-4 py-6">
          <div className="w-full max-w-3xl rounded-xl border border-slate-200 bg-white shadow-2xl">
            <div className="border-b border-slate-200 px-5 py-4">
              <h3 className="text-lg font-semibold text-slate-900">Firma digital para cierre de calificaciones</h3>
              <p className="mt-1 text-sm text-slate-600">
                Materia: <span className="font-medium">{signatureModalContext.courseName}</span> | Alumnos a cerrar:{" "}
                <span className="font-medium">{signatureModalContext.rows.length}</span>
              </p>
            </div>

            <div className="space-y-4 px-5 py-4">
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">
                    Nombre del profesor firmante
                  </label>
                  <input
                    type="text"
                    value={signerNameInput}
                    onChange={(event) => {
                      setSignerNameInput(event.target.value);
                      if (signatureError) setSignatureError(null);
                    }}
                    placeholder="Escribe tu nombre completo"
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                  />
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  <p>
                    Fecha de solicitud:{" "}
                    <span className="font-medium">{formatDateTime(signatureModalContext.requestedAt)}</span>
                  </p>
                  <p className="mt-1">
                    Grupo: <span className="font-medium">{groupId}</span>
                  </p>
                </div>
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">
                    Firma manuscrita
                  </label>
                  <button
                    type="button"
                    onClick={clearSignatureCanvas}
                    className="rounded-md border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                  >
                    Limpiar firma
                  </button>
                </div>
                <canvas
                  ref={signatureCanvasRef}
                  className="h-40 w-full rounded-lg border border-slate-300 bg-white"
                  style={{ touchAction: "none" }}
                  onPointerDown={handleSignaturePointerDown}
                  onPointerMove={handleSignaturePointerMove}
                  onPointerUp={handleSignaturePointerEnd}
                  onPointerLeave={handleSignaturePointerEnd}
                  onPointerCancel={handleSignaturePointerEnd}
                />
              </div>

              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">
                  Resumen de calificaciones a cerrar
                </p>
                <div className="mt-2 max-h-32 overflow-auto text-xs text-slate-700">
                  {signatureModalContext.rows.slice(0, 6).map((row) => (
                    <p key={`${row.studentId}-${row.finalGrade}`} className="py-0.5">
                      {row.studentName || "Sin nombre"} | Final {row.finalGrade.toFixed(1)} | Auto{" "}
                      {typeof row.autoGrade === "number" ? row.autoGrade.toFixed(1) : "—"} | Pendientes{" "}
                      {row.pendingUngradedCount}/{row.totalEvaluable}
                    </p>
                  ))}
                  {signatureModalContext.rows.length > 6 ? (
                    <p className="pt-1 text-slate-500">
                      ... y {signatureModalContext.rows.length - 6} alumno(s) más.
                    </p>
                  ) : null}
                </div>
              </div>

              {signatureError ? (
                <p className="text-sm font-medium text-red-600">{signatureError}</p>
              ) : null}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-4">
              <button
                type="button"
                onClick={() => resolveSignatureModal(null)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={confirmDigitalSignature}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
              >
                Firmar y continuar
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {confirmationModalContext ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/55 px-4 py-6">
          <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white shadow-2xl">
            <div className="border-b border-slate-200 px-5 py-4">
              <h3 className="text-lg font-semibold text-slate-900">{confirmationModalContext.title}</h3>
            </div>
            <div className="px-5 py-4">
              <p className="text-sm text-slate-700">{confirmationModalContext.message}</p>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-4">
              <button
                type="button"
                onClick={() => resolveConfirmationModal(false)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
              >
                {confirmationModalContext.cancelLabel ?? "Cancelar"}
              </button>
              <button
                type="button"
                onClick={() => resolveConfirmationModal(true)}
                className={`rounded-lg px-4 py-2 text-sm font-semibold text-white ${
                  confirmationModalContext.tone === "danger"
                    ? "bg-red-600 hover:bg-red-500"
                    : confirmationModalContext.tone === "warning"
                      ? "bg-amber-600 hover:bg-amber-500"
                      : "bg-slate-900 hover:bg-slate-800"
                }`}
              >
                {confirmationModalContext.confirmLabel ?? "Confirmar"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
