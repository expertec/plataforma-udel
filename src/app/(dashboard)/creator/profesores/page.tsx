"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { User, onAuthStateChanged } from "firebase/auth";
import { useRouter } from "next/navigation";
import { auth } from "@/lib/firebase/client";
import { isAdminTeacherRole, resolveUserRole } from "@/lib/firebase/roles";
import {
  createTeacherAccount,
  deactivateTeacher,
  getTeacherWorkloadReport,
  getTeacherUsers,
  TeacherUser,
  TeacherWorkloadReportRow,
} from "@/lib/firebase/teachers-service";
import { createPlantel, getPlanteles, Plantel } from "@/lib/firebase/planteles-service";

type EditableTeacherRole = "teacher" | "adminTeacher" | "coordinadorPlantel";

const EDITABLE_TEACHER_ROLES: EditableTeacherRole[] = [
  "teacher",
  "adminTeacher",
  "coordinadorPlantel",
];

function isEditableTeacherRole(role: TeacherUser["role"]): role is EditableTeacherRole {
  return EDITABLE_TEACHER_ROLES.includes(role as EditableTeacherRole);
}

function getTeacherRoleLabel(role: TeacherUser["role"]): string {
  if (role === "superAdminTeacher") return "SuperAdminTeacher";
  if (role === "adminTeacher") return "AdminTeacher";
  if (role === "coordinadorPlantel") return "Coordinador de plantel";
  return "Profesor";
}

const moneyFormatter = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
  maximumFractionDigits: 2,
});

const integerFormatter = new Intl.NumberFormat("es-MX");

const parseNumericInput = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return parsed >= 0 ? parsed : 0;
};

const toCurrency = (value: number): string => moneyFormatter.format(Number.isFinite(value) ? value : 0);

const toInteger = (value: number): string =>
  integerFormatter.format(Number.isFinite(value) ? Math.round(value) : 0);

const toCsvField = (value: string | number): string => {
  const raw = String(value ?? "");
  const escaped = raw.replace(/"/g, "\"\"");
  return `"${escaped}"`;
};

const toProgramBreakdownText = (
  programBreakdown: TeacherWorkloadReportRow["programBreakdown"],
): string => {
  if (!programBreakdown || programBreakdown.length === 0) return "Sin materias";
  return programBreakdown
    .map((item) => `${item.program}: ${toInteger(item.courses)}`)
    .join(" | ");
};

const toLevelBreakdownText = (
  levelBreakdown: TeacherWorkloadReportRow["levelBreakdown"],
): string =>
  `P:${toInteger(levelBreakdown.preparatoria)} / L:${toInteger(levelBreakdown.licenciatura)} / O:${toInteger(levelBreakdown.otros)} / S:${toInteger(levelBreakdown.sinPrograma)}`;

const toCompactList = (items: string[], maxVisible = 4): string => {
  if (!items || items.length === 0) return "—";
  if (items.length <= maxVisible) return items.join(", ");
  return `${items.slice(0, maxVisible).join(", ")} +${items.length - maxVisible}`;
};

const toCourseDetailsText = (
  courseDetails: TeacherWorkloadReportRow["courseDetails"],
): string => {
  if (!courseDetails || courseDetails.length === 0) return "Sin materias";
  return courseDetails
    .map((course) => `${course.courseName} (${toInteger(course.groupsCount)} grupo${course.groupsCount === 1 ? "" : "s"})`)
    .join(" | ");
};

function mergeAuthHeaders(token: string, headers?: HeadersInit): Headers {
  const merged = new Headers(headers ?? {});
  merged.set("Authorization", `Bearer ${token}`);
  return merged;
}

export default function ProfesoresPage() {
  const [teachers, setTeachers] = useState<TeacherUser[]>([]);
  const [activeTab, setActiveTab] = useState<"gestion" | "altas" | "reporte">("gestion");
  const [teacherSearchQuery, setTeacherSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [currentUser, setCurrentUser] = useState<User | null>(auth.currentUser);
  const [newTeacher, setNewTeacher] = useState({
    name: "",
    email: "",
    password: "",
    admin: false,
    phone: "",
  });
  const [roleReady, setRoleReady] = useState(false);
  const [isAdminTeacher, setIsAdminTeacher] = useState(false);
  const [deletingTeacherId, setDeletingTeacherId] = useState<string | null>(null);
  const router = useRouter();

  // Estados para editar profesor
  const [editProfileModalOpen, setEditProfileModalOpen] = useState(false);
  const [changePasswordModalOpen, setChangePasswordModalOpen] = useState(false);
  const [selectedTeacher, setSelectedTeacher] = useState<TeacherUser | null>(null);
  const [newPassword, setNewPassword] = useState("ascensoUDEL");
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newRole, setNewRole] = useState<EditableTeacherRole>("teacher");
  const [planteles, setPlanteles] = useState<Plantel[]>([]);
  const [selectedPlantelId, setSelectedPlantelId] = useState("");
  const [newPlantelName, setNewPlantelName] = useState("");
  const [creatingPlantel, setCreatingPlantel] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [updatingProfile, setUpdatingProfile] = useState(false);
  const [reportRows, setReportRows] = useState<TeacherWorkloadReportRow[]>([]);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [reportSearch, setReportSearch] = useState("");
  const [reportModalOpen, setReportModalOpen] = useState(false);
  const [salaryConfig, setSalaryConfig] = useState({
    perCourseLicenciatura: 1900,
    perCoursePreparatoria: 0,
    perCourseOtros: 0,
    perCourseSinPrograma: 0,
  });

  const fetchWithToken = useCallback(
    async (url: string, init?: RequestInit): Promise<Response> => {
      if (!currentUser) {
        throw new Error("No hay sesión activa");
      }
      const token = await currentUser.getIdToken();
      return fetch(url, {
        ...init,
        headers: mergeAuthHeaders(token, init?.headers),
      });
    },
    [currentUser],
  );

  const loadTeachers = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getTeacherUsers(200);
      setTeachers(data);
    } catch (err) {
      console.error(err);
      toast.error("No se pudieron cargar los profesores.");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPlanteles = useCallback(async () => {
    try {
      const data = await getPlanteles();
      setPlanteles(data);
    } catch (err) {
      console.error(err);
      toast.error("No se pudieron cargar los planteles.");
    }
  }, []);

  const loadTeacherWorkloadReport = useCallback(async () => {
    setReportLoading(true);
    setReportError(null);
    try {
      const rows = await getTeacherWorkloadReport(300);
      setReportRows(rows);
    } catch (err) {
      console.error(err);
      setReportError("No se pudo generar el reporte de carga por profesor.");
      toast.error("No se pudo cargar el reporte de profesores.");
    } finally {
      setReportLoading(false);
    }
  }, []);

  const refreshTeachersAndReport = useCallback(async () => {
    await Promise.all([loadTeachers(), loadTeacherWorkloadReport()]);
  }, [loadTeacherWorkloadReport, loadTeachers]);

  const handleOpenReportModal = useCallback(() => {
    setReportModalOpen(true);
    if (reportRows.length === 0) {
      void loadTeacherWorkloadReport();
    }
  }, [loadTeacherWorkloadReport, reportRows.length]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      setCurrentUser(user);
      if (!user) {
        router.replace("/");
        setRoleReady(true);
        setIsAdminTeacher(false);
        return;
      }
      try {
        const role = await resolveUserRole(user);
        setRoleReady(true);
        if (!role) {
          router.replace("/");
          setIsAdminTeacher(false);
          return;
        }
        if (!isAdminTeacherRole(role)) {
          router.replace("/creator");
          setIsAdminTeacher(false);
          return;
        }
        setIsAdminTeacher(true);
      } catch {
        setRoleReady(true);
        setIsAdminTeacher(false);
        router.replace("/");
      }
    });
    return () => unsub();
  }, [router]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem("teacherCoursePayConfig");
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as {
        perCourseLicenciatura?: number;
        perCoursePreparatoria?: number;
        perCourseOtros?: number;
        perCourseSinPrograma?: number;
      };
      setSalaryConfig({
        perCourseLicenciatura: parseNumericInput(String(parsed.perCourseLicenciatura ?? 1900)),
        perCoursePreparatoria: parseNumericInput(String(parsed.perCoursePreparatoria ?? 0)),
        perCourseOtros: parseNumericInput(String(parsed.perCourseOtros ?? 0)),
        perCourseSinPrograma: parseNumericInput(String(parsed.perCourseSinPrograma ?? 0)),
      });
    } catch {
      // Ignorar configuración inválida en localStorage.
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      "teacherCoursePayConfig",
      JSON.stringify(salaryConfig),
    );
  }, [salaryConfig]);

  useEffect(() => {
    if (!isAdminTeacher) return;
    void loadTeachers();
    void loadPlanteles();
  }, [isAdminTeacher, loadPlanteles, loadTeachers]);

  const handleCreateTeacher = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!newTeacher.email || !newTeacher.password) {
      toast.error("Completa correo y contraseña.");
      return;
    }
    setCreating(true);
    try {
      await createTeacherAccount({
        name: newTeacher.name || "Profesor",
        email: newTeacher.email.trim().toLowerCase(),
        password: newTeacher.password.trim(),
        asAdminTeacher: newTeacher.admin,
        phone: newTeacher.phone.trim(),
        createdBy: currentUser?.uid ?? null,
      });
      toast.success(
        newTeacher.admin
          ? "AdminTeacher creado con acceso por correo/contraseña"
          : "Profesor creado con acceso por correo/contraseña",
      );
      setNewTeacher({ name: "", email: "", password: "", admin: false, phone: "" });
      await refreshTeachersAndReport();
    } catch (err: unknown) {
      console.error(err);
      const code = (err as { code?: string })?.code ?? "";
      const message =
        code === "auth/email-already-in-use"
          ? "Ese correo ya está registrado."
          : "No se pudo crear el profesor.";
      toast.error(message);
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteTeacher = async (teacher: TeacherUser) => {
    if (!teacher.id) return;
    if (!window.confirm(`¿Eliminar a ${teacher.name}? Ya no podrá iniciar sesión.`)) return;
    setDeletingTeacherId(teacher.id);
    try {
      await deactivateTeacher(teacher.id);
      toast.success("Profesor desactivado");
      await refreshTeachersAndReport();
    } catch (err) {
      console.error(err);
      toast.error("No se pudo eliminar al profesor");
    } finally {
      setDeletingTeacherId(null);
    }
  };

  const handleOpenEditProfile = (teacher: TeacherUser) => {
    setSelectedTeacher(teacher);
    setNewEmail(teacher.email);
    setNewName(teacher.name);
    setNewPhone(teacher.phone || "");
    setNewRole(isEditableTeacherRole(teacher.role) ? teacher.role : "teacher");
    setSelectedPlantelId(teacher.plantelId ?? "");
    setNewPlantelName("");
    setEditProfileModalOpen(true);
  };

  const handleOpenChangePassword = (teacher: TeacherUser) => {
    setSelectedTeacher(teacher);
    setNewPassword("ascensoUDEL");
    setChangePasswordModalOpen(true);
  };

  const handleUpdateProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTeacher) return;

    const emailChanged = newEmail.trim().toLowerCase() !== selectedTeacher.email.toLowerCase();
    const nameChanged = newName.trim() !== selectedTeacher.name;
    const phoneChanged = newPhone.trim() !== (selectedTeacher.phone || "");
    const roleChanged =
      isEditableTeacherRole(selectedTeacher.role) && newRole !== selectedTeacher.role;
    const selectedPlantel = planteles.find((plantel) => plantel.id === selectedPlantelId);
    const plantelChanged =
      newRole === "coordinadorPlantel" &&
      selectedPlantelId !== (selectedTeacher.plantelId ?? "");

    if (newRole === "coordinadorPlantel" && !selectedPlantel) {
      toast.error("Selecciona un plantel para el coordinador.");
      return;
    }

    if (!emailChanged && !nameChanged && !phoneChanged && !roleChanged && !plantelChanged) {
      toast("No hay cambios para guardar");
      return;
    }

    setUpdatingProfile(true);
    try {
      if (roleChanged || plantelChanged) {
        const roleResponse = await fetchWithToken("/api/admin/teachers/update-role", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            teacherId: selectedTeacher.id,
            newRole,
            plantelId: newRole === "coordinadorPlantel" ? selectedPlantel?.id : null,
            plantelName: newRole === "coordinadorPlantel" ? selectedPlantel?.name : null,
          }),
        });
        const roleData = (await roleResponse.json().catch(() => ({}))) as { error?: string };
        if (!roleResponse.ok) {
          throw new Error(roleData.error || "Error al actualizar rol");
        }
      }

      if (emailChanged || nameChanged || phoneChanged) {
        const profileResponse = await fetch("/api/teachers/update-profile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            teacherId: selectedTeacher.id,
            currentEmail: selectedTeacher.email,
            newEmail: emailChanged ? newEmail.trim() : undefined,
            newName: nameChanged ? newName.trim() : undefined,
            newPhone: phoneChanged ? newPhone.trim() : undefined,
          }),
        });

        const profileData = (await profileResponse.json().catch(() => ({}))) as { error?: string };
        if (!profileResponse.ok) {
          throw new Error(profileData.error || "Error al actualizar perfil");
        }
      }

      toast.success("Datos actualizados correctamente");
      setEditProfileModalOpen(false);
      setSelectedTeacher(null);
      await refreshTeachersAndReport();
    } catch (err: unknown) {
      console.error(err);
      const message =
        err instanceof Error ? err.message : "No se pudo actualizar el perfil";
      toast.error(message);
    } finally {
      setUpdatingProfile(false);
    }
  };

  const handleCreatePlantel = async () => {
    const trimmed = newPlantelName.trim();
    if (!trimmed) {
      toast.error("Escribe el nombre del plantel.");
      return;
    }
    setCreatingPlantel(true);
    try {
      const plantel = await createPlantel(trimmed);
      setPlanteles((prev) => {
        if (prev.some((item) => item.id === plantel.id)) return prev;
        return [...prev, plantel].sort((a, b) => a.name.localeCompare(b.name, "es"));
      });
      setSelectedPlantelId(plantel.id);
      setNewPlantelName("");
      toast.success("Plantel agregado.");
    } catch (err) {
      console.error(err);
      toast.error("No se pudo crear el plantel.");
    } finally {
      setCreatingPlantel(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTeacher) return;

    if (newPassword.length < 6) {
      toast.error("La contraseña debe tener al menos 6 caracteres");
      return;
    }

    setChangingPassword(true);
    try {
      const response = await fetch("/api/teachers/update-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teacherId: selectedTeacher.id,
          currentEmail: selectedTeacher.email,
          newPassword: newPassword,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Error al cambiar contraseña");
      }

      toast.success("Contraseña actualizada correctamente");
      setChangePasswordModalOpen(false);
      setNewPassword("ascensoUDEL");
    } catch (err: unknown) {
      console.error(err);
      const message =
        err instanceof Error ? err.message : "No se pudo cambiar la contraseña";
      toast.error(message);
    } finally {
      setChangingPassword(false);
    }
  };

  const reportRowsWithSalary = useMemo(() => {
    const normalizedSearch = reportSearch.trim().toLowerCase();
    const rows = reportRows.filter((row) => {
      if (!normalizedSearch) return true;
      return (
        row.teacherName.toLowerCase().includes(normalizedSearch) ||
        row.teacherEmail.toLowerCase().includes(normalizedSearch)
      );
    });

    const withSalary = rows.map((row) => {
      const estimatedSalary =
        row.levelBreakdown.licenciatura * salaryConfig.perCourseLicenciatura +
        row.levelBreakdown.preparatoria * salaryConfig.perCoursePreparatoria +
        row.levelBreakdown.otros * salaryConfig.perCourseOtros +
        row.levelBreakdown.sinPrograma * salaryConfig.perCourseSinPrograma;
      return {
        ...row,
        estimatedSalary,
      };
    });

    withSalary.sort((a, b) => {
      if (b.estimatedSalary !== a.estimatedSalary) return b.estimatedSalary - a.estimatedSalary;
      if (b.activeStudents !== a.activeStudents) return b.activeStudents - a.activeStudents;
      return a.teacherName.localeCompare(b.teacherName, "es");
    });
    return withSalary;
  }, [reportRows, reportSearch, salaryConfig]);

  const reportTotals = useMemo(
    () =>
      reportRowsWithSalary.reduce(
        (acc, row) => {
          acc.totalGroups += row.totalGroups;
          acc.activeGroups += row.activeGroups;
          acc.totalStudents += row.totalStudents;
          acc.activeStudents += row.activeStudents;
          acc.totalClasses += row.totalClasses;
          acc.activeClasses += row.activeClasses;
          acc.totalUniqueCourses += row.uniqueCourses;
          acc.totalEstimatedSalary += row.estimatedSalary;
          return acc;
        },
        {
          totalGroups: 0,
          activeGroups: 0,
          totalStudents: 0,
          activeStudents: 0,
          totalClasses: 0,
          activeClasses: 0,
          totalUniqueCourses: 0,
          totalEstimatedSalary: 0,
        },
      ),
    [reportRowsWithSalary],
  );

  const handleDownloadReportCsv = useCallback(() => {
    if (reportRowsWithSalary.length === 0) {
      toast.error("No hay datos del reporte para exportar.");
      return;
    }
    const header = [
      "Profesor",
      "Email",
      "Rol",
      "Grupos activos",
      "Grupos totales",
      "Alumnos activos",
      "Alumnos totales",
      "Clases activas",
      "Clases totales",
      "Materias unicas",
      "Programas unicos",
      "Materias prepa",
      "Materias licenciatura",
      "Materias otros",
      "Materias sin programa",
      "Grupos (nombres)",
      "Materias por programa",
      "Materias detalle",
      "Tarifa licenciatura MXN",
      "Tarifa preparatoria MXN",
      "Tarifa otros MXN",
      "Tarifa sin programa MXN",
      "Pago estimado MXN",
    ];
    const body = reportRowsWithSalary.map((row) =>
      [
        row.teacherName,
        row.teacherEmail,
        getTeacherRoleLabel(row.role),
        row.activeGroups,
        row.totalGroups,
        row.activeStudents,
        row.totalStudents,
        row.activeClasses,
        row.totalClasses,
        row.uniqueCourses,
        row.uniquePrograms,
        row.levelBreakdown.preparatoria,
        row.levelBreakdown.licenciatura,
        row.levelBreakdown.otros,
        row.levelBreakdown.sinPrograma,
        toCompactList(row.groupNames, 8),
        toProgramBreakdownText(row.programBreakdown),
        toCourseDetailsText(row.courseDetails),
        salaryConfig.perCourseLicenciatura.toFixed(2),
        salaryConfig.perCoursePreparatoria.toFixed(2),
        salaryConfig.perCourseOtros.toFixed(2),
        salaryConfig.perCourseSinPrograma.toFixed(2),
        row.estimatedSalary.toFixed(2),
      ]
        .map((value) => toCsvField(value))
        .join(","),
    );
    const csv = [header.map((value) => toCsvField(value)).join(","), ...body].join("\n");
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `reporte-profesores-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }, [reportRowsWithSalary, salaryConfig]);

  const filteredTeachers = useMemo(() => {
    const normalizedQuery = teacherSearchQuery.trim().toLowerCase();
    if (!normalizedQuery) return teachers;

    return teachers.filter((teacher) => {
      const searchableRole = getTeacherRoleLabel(teacher.role).toLowerCase();
      return (
        teacher.name.toLowerCase().includes(normalizedQuery) ||
        teacher.email.toLowerCase().includes(normalizedQuery) ||
        (teacher.phone || "").toLowerCase().includes(normalizedQuery) ||
        (teacher.plantelName || "").toLowerCase().includes(normalizedQuery) ||
        searchableRole.includes(normalizedQuery)
      );
    });
  }, [teachers, teacherSearchQuery]);

  const teacherTabs: { key: "gestion" | "altas" | "reporte"; label: string }[] = [
    { key: "gestion", label: "Listado y acciones" },
    { key: "altas", label: "Altas" },
    { key: "reporte", label: "Reporte" },
  ];

  return (
    <div className="space-y-4">
      {!roleReady ? (
        <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-700 shadow-sm">
          Verificando permisos...
        </div>
      ) : null}
      <div>
        <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Profesores</p>
        <h1 className="text-2xl font-semibold text-slate-900">Administrar profesores</h1>
        <p className="text-sm text-slate-600">
          Crea cuentas de profesores y AdminTeacher con acceso por correo y contraseña.
          Desde editar perfil también puedes cambiar el rol a Coordinador de plantel.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 rounded-xl border border-slate-200 bg-white p-2 text-sm shadow-sm">
        {teacherTabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={`rounded-lg px-4 py-2 font-semibold transition ${
              activeTab === tab.key
                ? "bg-blue-600 text-white shadow-sm"
                : "text-slate-700 hover:bg-slate-100"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "altas" ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <form
            onSubmit={handleCreateTeacher}
            className="grid gap-3 md:grid-cols-2 md:items-end"
          >
            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">Nombre</label>
              <input
                type="text"
                value={newTeacher.name}
                onChange={(e) => setNewTeacher((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="Nombre del profesor"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">Teléfono / WhatsApp</label>
              <input
                type="text"
                value={newTeacher.phone}
                onChange={(e) => setNewTeacher((prev) => ({ ...prev, phone: e.target.value }))}
                placeholder="+52..."
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">Correo</label>
              <input
                type="email"
                required
                value={newTeacher.email}
                onChange={(e) => setNewTeacher((prev) => ({ ...prev, email: e.target.value }))}
                placeholder="correo@ejemplo.com"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">Contraseña</label>
              <input
                type="password"
                required
                minLength={6}
                value={newTeacher.password}
                onChange={(e) => setNewTeacher((prev) => ({ ...prev, password: e.target.value }))}
                placeholder="Mínimo 6 caracteres"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div className="flex flex-col gap-3">
              <label className="inline-flex items-center gap-2 text-sm font-medium text-slate-700">
                <input
                  type="checkbox"
                  checked={newTeacher.admin}
                  onChange={(e) => setNewTeacher((prev) => ({ ...prev, admin: e.target.checked }))}
                  className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                />
                Crear como AdminTeacher (acceso ampliado)
              </label>
              <button
                type="submit"
                disabled={creating}
                className="inline-flex items-center justify-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {creating ? "Creando..." : "Registrar profesor"}
              </button>
            </div>
          </form>
          <p className="mt-2 text-xs text-slate-600">
            Esta acción crea el usuario en Firebase Auth y su documento en <code>users</code> con
            rol docente.
          </p>
        </div>
      ) : null}

      {activeTab === "reporte" ? (
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Reporte de materias y grupos</h2>
              <p className="text-sm text-slate-600">
                Consulta detalle de cursos (materias), grupos y pago por materia en una modal.
              </p>
            </div>
            <button
              type="button"
              onClick={handleOpenReportModal}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700"
            >
              Abrir reporte
            </button>
          </div>
        </div>
      ) : null}

      {reportModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 px-4 py-6">
          <div className="w-full max-w-7xl rounded-2xl bg-white p-4 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">Reporte de materias, cursos y grupos</h2>
                <p className="text-sm text-slate-600">
                  Pago calculado solo por materia impartida.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setReportModalOpen(false)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
              >
                Cerrar
              </button>
            </div>

            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={loadTeacherWorkloadReport}
                  disabled={reportLoading}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed"
                >
                  {reportLoading ? "Actualizando..." : "Actualizar reporte"}
                </button>
                <button
                  type="button"
                  onClick={handleDownloadReportCsv}
                  disabled={reportLoading || reportRowsWithSalary.length === 0}
                  className="rounded-lg border border-blue-200 px-3 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:border-blue-100 disabled:text-blue-300"
                >
                  Exportar CSV
                </button>
              </div>

              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                <div className="space-y-1">
                  <label className="text-sm font-medium text-slate-700">Tarifa por materia (Licenciatura)</label>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={salaryConfig.perCourseLicenciatura}
                    onChange={(event) =>
                      setSalaryConfig((prev) => ({
                        ...prev,
                        perCourseLicenciatura: parseNumericInput(event.target.value),
                      }))
                    }
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium text-slate-700">Tarifa por materia (Preparatoria)</label>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={salaryConfig.perCoursePreparatoria}
                    onChange={(event) =>
                      setSalaryConfig((prev) => ({
                        ...prev,
                        perCoursePreparatoria: parseNumericInput(event.target.value),
                      }))
                    }
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium text-slate-700">Tarifa por materia (Otros)</label>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={salaryConfig.perCourseOtros}
                    onChange={(event) =>
                      setSalaryConfig((prev) => ({
                        ...prev,
                        perCourseOtros: parseNumericInput(event.target.value),
                      }))
                    }
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium text-slate-700">Tarifa por materia (Sin programa)</label>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={salaryConfig.perCourseSinPrograma}
                    onChange={(event) =>
                      setSalaryConfig((prev) => ({
                        ...prev,
                        perCourseSinPrograma: parseNumericInput(event.target.value),
                      }))
                    }
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium text-slate-700">Buscar profesor</label>
                  <input
                    type="text"
                    value={reportSearch}
                    onChange={(event) => setReportSearch(event.target.value)}
                    placeholder="Nombre o correo"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  />
                </div>
              </div>

              {reportError ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                  {reportError}
                </div>
              ) : null}

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Profesores</p>
                  <p className="text-lg font-semibold text-slate-900">{toInteger(reportRowsWithSalary.length)}</p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Grupos totales</p>
                  <p className="text-lg font-semibold text-slate-900">{toInteger(reportTotals.totalGroups)}</p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Materias totales</p>
                  <p className="text-lg font-semibold text-slate-900">{toInteger(reportTotals.totalUniqueCourses)}</p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Pago estimado total</p>
                  <p className="text-lg font-semibold text-slate-900">
                    {toCurrency(reportTotals.totalEstimatedSalary)}
                  </p>
                </div>
              </div>

              {reportLoading ? (
                <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-5 text-sm text-slate-600">
                  Generando reporte de profesores...
                </div>
              ) : reportRowsWithSalary.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-5 text-sm text-slate-600">
                  No hay datos para mostrar en el reporte.
                </div>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <table className="min-w-[1600px] w-full text-sm">
                    <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-600">
                      <tr>
                        <th className="px-3 py-2 text-left">Profesor</th>
                        <th className="px-3 py-2 text-left">Grupos</th>
                        <th className="px-3 py-2 text-left">Materias (cursos)</th>
                        <th className="px-3 py-2 text-right">Niveles P/L/O/S</th>
                        <th className="px-3 py-2 text-left">Programas</th>
                        <th className="px-3 py-2 text-right">Pago estimado</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {reportRowsWithSalary.map((row) => (
                        <tr key={row.teacherId} className="text-slate-800">
                          <td className="px-3 py-2">
                            <div className="font-medium">{row.teacherName}</div>
                            <div className="text-xs text-slate-500">{row.teacherEmail || "Sin correo"}</div>
                            <div className="text-xs text-slate-500">{getTeacherRoleLabel(row.role)}</div>
                          </td>
                          <td className="px-3 py-2 text-xs text-slate-600">
                            <div className="font-medium text-slate-800">{toInteger(row.totalGroups)} grupo(s)</div>
                            <div>{toCompactList(row.groupNames, 6)}</div>
                          </td>
                          <td className="px-3 py-2 text-xs text-slate-600">
                            <div className="font-medium text-slate-800">{toInteger(row.uniqueCourses)} materia(s)</div>
                            <div>{toCourseDetailsText(row.courseDetails)}</div>
                          </td>
                          <td className="px-3 py-2 text-right">{toLevelBreakdownText(row.levelBreakdown)}</td>
                          <td className="px-3 py-2 text-xs text-slate-600">
                            {toProgramBreakdownText(row.programBreakdown)}
                          </td>
                          <td className="px-3 py-2 text-right font-semibold text-slate-900">
                            {toCurrency(row.estimatedSalary)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="border-t border-slate-300 bg-slate-50 text-xs font-semibold text-slate-700">
                      <tr>
                        <td className="px-3 py-2">Totales</td>
                        <td className="px-3 py-2">{toInteger(reportTotals.totalGroups)} grupos</td>
                        <td className="px-3 py-2">{toInteger(reportTotals.totalUniqueCourses)} materias</td>
                        <td className="px-3 py-2 text-right">-</td>
                        <td className="px-3 py-2">-</td>
                        <td className="px-3 py-2 text-right">{toCurrency(reportTotals.totalEstimatedSalary)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {activeTab === "gestion" ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => {
                void loadTeachers();
              }}
              disabled={loading}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed"
            >
              {loading ? "Actualizando..." : "Refrescar"}
            </button>
            <span className="text-sm text-slate-600">
              Listado de profesores, AdminTeacher y Coordinador de plantel.
            </span>
          </div>

          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="relative flex-1">
                <input
                  type="text"
                  value={teacherSearchQuery}
                  onChange={(event) => setTeacherSearchQuery(event.target.value)}
                  placeholder="Buscar por nombre, correo, teléfono o rol..."
                  className="w-full rounded-lg border border-slate-300 px-4 py-2 pl-10 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
                />
                <svg
                  className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                  />
                </svg>
                {teacherSearchQuery ? (
                  <button
                    type="button"
                    onClick={() => setTeacherSearchQuery("")}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  >
                    <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                  </button>
                ) : null}
              </div>
              <span className="text-sm text-slate-600">
                {filteredTeachers.length} de {teachers.length}
              </span>
            </div>

            {loading ? (
              <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">
                Cargando profesores...
              </div>
            ) : teachers.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">
                No se encontraron profesores registrados.
              </div>
            ) : filteredTeachers.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">
                {`No se encontraron profesores que coincidan con "${teacherSearchQuery}".`}
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
                <div className="grid grid-cols-[1.3fr_2fr_1fr_0.95fr_0.8fr_1.5fr] gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs font-semibold text-slate-600">
                  <span>Nombre</span>
                  <span>Email</span>
                  <span>Teléfono</span>
                  <span>Rol</span>
                  <span>Estado</span>
                  <span className="text-right">Acciones</span>
                </div>
                <div className="divide-y divide-slate-200">
                  {filteredTeachers.map((teacher) => (
                    <div
                      key={teacher.id}
                      className="grid grid-cols-[1.3fr_2fr_1fr_0.95fr_0.8fr_1.5fr] gap-3 px-4 py-2 text-sm text-slate-800"
                    >
                      <span>{teacher.name}</span>
                      <span className="text-slate-600 break-words">{teacher.email}</span>
                      <span className="text-slate-600">{teacher.phone || "—"}</span>
                      <span className="font-medium text-blue-700">
                        {getTeacherRoleLabel(teacher.role)}
                        {teacher.role === "coordinadorPlantel" ? (
                          <span className="mt-0.5 block text-[11px] font-normal text-slate-500">
                            {teacher.plantelName || "Sin plantel"}
                          </span>
                        ) : null}
                      </span>
                      <span className="font-medium text-green-600">Activo</span>
                      <span className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => handleOpenEditProfile(teacher)}
                          className="rounded-lg border border-blue-200 px-3 py-1 text-xs font-semibold text-blue-600 hover:border-blue-400"
                        >
                          Editar
                        </button>
                        <button
                          type="button"
                          onClick={() => handleOpenChangePassword(teacher)}
                          className="rounded-lg border border-amber-200 px-3 py-1 text-xs font-semibold text-amber-600 hover:border-amber-400"
                        >
                          Cambiar Contraseña
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteTeacher(teacher)}
                          disabled={deletingTeacherId === teacher.id}
                          className="rounded-lg border border-red-200 px-3 py-1 text-xs font-semibold text-red-600 hover:border-red-400 disabled:cursor-not-allowed disabled:border-red-200 disabled:text-red-300"
                        >
                          {deletingTeacherId === teacher.id ? "Eliminando..." : "Eliminar"}
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </>
      ) : null}

      {/* Modal para editar perfil */}
      {editProfileModalOpen && selectedTeacher && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 px-4 py-6">
          <div className="w-full max-w-md max-h-[calc(100vh-3rem)] overflow-y-auto rounded-lg bg-white p-6 shadow-xl">
            <h2 className="mb-4 text-xl font-semibold text-slate-900">
              Editar Perfil - {selectedTeacher.name}
            </h2>
            <form onSubmit={handleUpdateProfile} className="space-y-4">
              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-700">Nombre</label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  required
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-700">Email</label>
                <input
                  type="email"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  required
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-700">Teléfono</label>
                <input
                  type="text"
                  value={newPhone}
                  onChange={(e) => setNewPhone(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-700">Rol</label>
                <select
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value as EditableTeacherRole)}
                  disabled={!isEditableTeacherRole(selectedTeacher.role)}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:bg-slate-100 disabled:text-slate-500"
                >
                  <option value="teacher">Profesor</option>
                  <option value="adminTeacher">AdminTeacher</option>
                  <option value="coordinadorPlantel">Coordinador de plantel</option>
                </select>
                {!isEditableTeacherRole(selectedTeacher.role) ? (
                  <p className="text-xs text-amber-700">
                    El rol {getTeacherRoleLabel(selectedTeacher.role)} no se puede modificar desde este panel.
                  </p>
                ) : null}
              </div>
              {newRole === "coordinadorPlantel" ? (
                <div className="space-y-2 rounded-lg border border-blue-100 bg-blue-50 p-3">
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-slate-700">Plantel asignado</label>
                    <select
                      value={selectedPlantelId}
                      onChange={(e) => setSelectedPlantelId(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                      required
                    >
                      <option value="">Seleccionar plantel</option>
                      {planteles.map((plantel) => (
                        <option key={plantel.id} value={plantel.id}>
                          {plantel.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={newPlantelName}
                      onChange={(e) => setNewPlantelName(e.target.value)}
                      placeholder="Agregar nuevo plantel"
                      className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={handleCreatePlantel}
                      disabled={creatingPlantel}
                      className="rounded-lg border border-blue-200 bg-white px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {creatingPlantel ? "Agregando..." : "Agregar"}
                    </button>
                  </div>
                </div>
              ) : null}
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setEditProfileModalOpen(false);
                    setSelectedTeacher(null);
                  }}
                  className="flex-1 rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                  disabled={updatingProfile}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="flex-1 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-70"
                  disabled={updatingProfile}
                >
                  {updatingProfile ? "Guardando..." : "Guardar Cambios"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal para cambiar contraseña */}
      {changePasswordModalOpen && selectedTeacher && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 px-4 py-6">
          <div className="w-full max-w-md max-h-[calc(100vh-3rem)] overflow-y-auto rounded-lg bg-white p-6 shadow-xl">
            <h2 className="mb-4 text-xl font-semibold text-slate-900">
              Cambiar Contraseña - {selectedTeacher.name}
            </h2>
            <form onSubmit={handleChangePassword} className="space-y-4">
              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-700">Nueva Contraseña</label>
                <input
                  type="text"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  required
                  minLength={6}
                  placeholder="Mínimo 6 caracteres"
                />
                <p className="text-xs text-slate-500">
                  La contraseña debe tener al menos 6 caracteres
                </p>
              </div>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setChangePasswordModalOpen(false);
                    setNewPassword("ascensoUDEL");
                  }}
                  className="flex-1 rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                  disabled={changingPassword}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="flex-1 rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-70"
                  disabled={changingPassword}
                >
                  {changingPassword ? "Cambiando..." : "Cambiar Contraseña"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
