"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DocumentSnapshot } from "firebase/firestore";
import toast from "react-hot-toast";
import * as XLSX from "xlsx";
import { User, onAuthStateChanged } from "firebase/auth";
import { auth } from "@/lib/firebase/client";
import { isAdminTeacherRole, resolveUserRole, UserRole } from "@/lib/firebase/roles";
import { getPrograms } from "@/lib/firebase/programs-service";
import {
  createStudentAccount,
  deactivateStudent,
  getStudentUsersPaginated,
  getStudentsCount,
  StudentUser,
  createStudentIfNotExists,
  checkStudentExists,
} from "@/lib/firebase/students-service";
import { getGroupStudents, getGroupsForTeacher } from "@/lib/firebase/groups-service";
import { StudentAllSubmissionsModal } from "./_components/StudentAllSubmissionsModal";

type ParsedStudentRow = {
  row: number;
  name: string;
  email: string;
  password: string;
  phone?: string;
  program: string;
  missingProgram?: boolean;
  exists?: boolean;
  invalidEmail?: boolean;
};

type ImportResult = {
  row: number;
  email: string;
  status: "created" | "skipped" | "error";
  message?: string;
};

const isValidEmail = (email: string): boolean => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

export default function AlumnosPage() {
  const [students, setStudents] = useState<StudentUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [parsedRows, setParsedRows] = useState<ParsedStudentRow[]>([]);
  const [importResults, setImportResults] = useState<ImportResult[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [newStudent, setNewStudent] = useState({
    name: "",
    email: "",
    password: "",
    phone: "",
    program: "",
  });
  const [programOptions, setProgramOptions] = useState<string[]>([]);
  const [programLoading, setProgramLoading] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState<User | null>(auth.currentUser);
  const [userRole, setUserRole] = useState<UserRole | null>(null);
  const [deletingStudentId, setDeletingStudentId] = useState<string | null>(null);
  const [previewFilter, setPreviewFilter] = useState<"all" | "invalid" | "new" | "existing">("all");

  // Estados para actualización de contraseñas
  const [passwordFileName, setPasswordFileName] = useState<string | null>(null);
  const [parsedPasswordRows, setParsedPasswordRows] = useState<ParsedStudentRow[]>([]);
  const [passwordResults, setPasswordResults] = useState<ImportResult[]>([]);
  const [updatingPasswords, setUpdatingPasswords] = useState(false);
  const passwordFileInputRef = useRef<HTMLInputElement | null>(null);

  // Estados para editar alumno
  const [editProfileModalOpen, setEditProfileModalOpen] = useState(false);
  const [changePasswordModalOpen, setChangePasswordModalOpen] = useState(false);
  const [selectedStudent, setSelectedStudent] = useState<StudentUser | null>(null);
  const [newPassword, setNewPassword] = useState("ascensoUDEL");
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newProgram, setNewProgram] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);

  // Estado para búsqueda
  const [searchQuery, setSearchQuery] = useState("");

  // Estado para paginación
  const [lastDoc, setLastDoc] = useState<DocumentSnapshot | null>(null);
  const [hasMoreStudents, setHasMoreStudents] = useState(false);
  const [totalStudentsCount, setTotalStudentsCount] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // Estado para modal de tareas
  const [submissionsModalOpen, setSubmissionsModalOpen] = useState(false);
  const [selectedStudentForSubmissions, setSelectedStudentForSubmissions] = useState<StudentUser | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      setCurrentUser(user);
      if (!user) {
        setUserRole(null);
        return;
      }
      try {
        const role = await resolveUserRole(user);
        setUserRole(role);
      } catch {
        setUserRole(null);
      }
    });
    return () => unsub();
  }, []);

  // Ref para mantener el último documento sin causar re-renders
  const lastDocRef = useRef<DocumentSnapshot | null>(null);

  const loadStudents = useCallback(async (loadMore = false) => {
    const userId = currentUser?.uid;
    if (!userId || !userRole) return;

    if (loadMore) {
      setLoadingMore(true);
    } else {
      setLoading(true);
      lastDocRef.current = null;
      setLastDoc(null);
      setStudents([]);
    }

    try {
      if (isAdminTeacherRole(userRole)) {
        // Usar paginación para admins (reduce lecturas de ~10,000 a ~50 por página)
        const result = await getStudentUsersPaginated(
          50, // Cargar 50 estudiantes por página
          loadMore ? lastDocRef.current : null
        );

        if (loadMore) {
          setStudents((prev) => [...prev, ...result.students]);
        } else {
          setStudents(result.students);
          // Obtener conteo total solo en la primera carga
          const count = await getStudentsCount();
          setTotalStudentsCount(count);
        }

        lastDocRef.current = result.lastDoc;
        setLastDoc(result.lastDoc);
        setHasMoreStudents(result.hasMore);
        return;
      }

      // Para profesores normales, cargar estudiantes de sus grupos
      const groups = await getGroupsForTeacher(userId);
      const studentMap = new Map<string, StudentUser>();
      await Promise.all(
        groups.map(async (group) => {
          const groupStudents = await getGroupStudents(group.id);
          groupStudents.forEach((student) => {
            if (!student.studentEmail) return;
            if (studentMap.has(student.id)) return;
            studentMap.set(student.id, {
              id: student.id,
              name: student.studentName || "Alumno",
              email: student.studentEmail,
              estado: student.status,
            });
          });
        }),
      );
      setStudents(Array.from(studentMap.values()));
      setHasMoreStudents(false);
    } catch (err) {
      console.error(err);
      toast.error(
        isAdminTeacherRole(userRole)
          ? "No se pudieron cargar los alumnos (users)"
          : "No se pudieron cargar los alumnos de tus grupos",
      );
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [currentUser?.uid, userRole]);

  useEffect(() => {
    loadStudents(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.uid, userRole]);

  useEffect(() => {
    let active = true;
    const loadPrograms = async () => {
      setProgramLoading(true);
      try {
        const data = await getPrograms();
        if (!active) return;
        const names = Array.from(new Set(data.map((p) => p.name).filter(Boolean)));
        setProgramOptions(names);
      } catch (err) {
        console.error(err);
        toast.error("No se pudieron cargar los programas");
      } finally {
        if (active) setProgramLoading(false);
      }
    };
    loadPrograms();
    return () => {
      active = false;
    };
  }, []);

  const handleCreateStudent = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!newStudent.email || !newStudent.password) {
      toast.error("Completa email y contraseña");
      return;
    }
    if (!newStudent.program) {
      toast.error("Selecciona un programa");
      return;
    }
    setCreating(true);
    try {
      await createStudentAccount({
        name: newStudent.name || "Alumno",
        email: newStudent.email.trim().toLowerCase(),
        password: newStudent.password.trim(),
        createdBy: currentUser?.uid ?? null,
        phone: newStudent.phone.trim(),
        program: newStudent.program.trim(),
      });
      toast.success("Alumno creado con acceso por correo/contraseña");
      setNewStudent({ name: "", email: "", password: "", phone: "", program: "" });
      await loadStudents();
    } catch (err: unknown) {
      console.error(err);
      const code = (err as { code?: string })?.code ?? "";
      const message =
        code === "auth/email-already-in-use"
          ? "El correo ya está registrado."
          : "No se pudo crear el alumno.";
      toast.error(message);
    } finally {
      setCreating(false);
    }
  };

  const parseFile = async (file: File) => {
    setParseError(null);
    setImportResults([]);
    setParsedRows([]);
    setFileName(file.name);
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: "array" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!sheet) {
        setParseError("El archivo no tiene hojas válidas.");
        return;
      }
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
      const mapped = rows
        .map((row, idx) => {
          const name = String(
            row.Nombre ?? row.name ?? row.Name ?? row["Nombre completo"] ?? "",
          ).trim();
          const email = String(row.Email ?? row.Correo ?? row.email ?? "").trim().toLowerCase();
          const password = String(
            row.Password ?? row.Contraseña ?? row.Contrasena ?? row.password ?? "",
          ).trim();
          const phone = String(
            row.Phone ?? row.Telefono ?? row.WhatsApp ?? row.phone ?? row.whatsapp ?? "",
          ).trim();
          const program = String(
            row.Programa ?? row.programa ?? row.Program ?? row.program ?? row.Carrera ?? row.carrera ?? "",
          ).trim();
          if (!email) return null;
          return {
            row: idx + 2,
            name: name || "Alumno",
            email,
            password: password || "alumno123",
            phone: phone || "",
            program: program || "",
            missingProgram: !program,
            exists: undefined,
          };
        })
        .filter(Boolean) as ParsedStudentRow[];
      if (!mapped.length) {
        setParseError("No se encontraron filas válidas. Usa las columnas Nombre, Email, Password y Programa.");
        return;
      }

      toast.success(`Verificando existencia de ${mapped.length} alumnos...`);

      const mappedWithExists = await Promise.all(
        mapped.map(async (student) => {
          const invalidEmail = !isValidEmail(student.email);
          const exists = invalidEmail ? false : await checkStudentExists(student.email);
          return { ...student, exists, invalidEmail };
        }),
      );

      setParsedRows(mappedWithExists);
      const newCount = mappedWithExists.filter(
        (s) => !s.exists && !s.invalidEmail && !s.missingProgram,
      ).length;
      const existingCount = mappedWithExists.filter((s) => s.exists).length;
      const invalidCount = mappedWithExists.filter((s) => s.invalidEmail).length;
      const missingProgramCount = mappedWithExists.filter((s) => s.missingProgram).length;

      if (invalidCount > 0 || missingProgramCount > 0) {
        toast.error(
          `Archivo listo: ${newCount} nuevos, ${existingCount} ya existen, ${invalidCount} emails inválidos, ${missingProgramCount} sin programa`,
          { duration: 5000 }
        );
      } else {
        toast.success(
          `Archivo listo: ${newCount} nuevos, ${existingCount} ya existen`,
        );
      }
    } catch (err) {
      console.error(err);
      setParseError("No se pudo leer el archivo. Verifica el formato .xlsx");
    }
  };

  const handleImportStudents = async () => {
    if (!parsedRows.length) {
      toast.error("Primero carga un archivo de alumnos.");
      return;
    }
    setImporting(true);
    const results: ImportResult[] = [];
    for (const row of parsedRows) {
      if (row.invalidEmail) {
        results.push({
          row: row.row,
          email: row.email,
          status: "error",
          message: "Email inválido",
        });
        continue;
      }
      if (row.missingProgram) {
        results.push({
          row: row.row,
          email: row.email,
          status: "error",
          message: "Programa requerido",
        });
        continue;
      }
      try {
        const result = await createStudentIfNotExists({
          name: row.name,
          email: row.email,
          password: row.password,
          createdBy: currentUser?.uid ?? null,
          phone: row.phone,
          program: row.program,
        });
        results.push({
          row: row.row,
          email: row.email,
          status: result.alreadyExisted ? "skipped" : "created",
          message: result.alreadyExisted ? "Ya existía" : undefined,
        });
      } catch (err: unknown) {
        console.error(err);
        const message = (err as { message?: string })?.message || "No se pudo crear";
        results.push({ row: row.row, email: row.email, status: "error", message });
      }
    }
    setImportResults(results);
    setImporting(false);
    await loadStudents();
    const created = results.filter((r) => r.status === "created").length;
    const skipped = results.filter((r) => r.status === "skipped").length;
    const errors = results.filter((r) => r.status === "error").length;
    toast.success(
      `Importación finalizada: ${created} creados, ${skipped} omitidos, ${errors} errores.`,
    );
  };

  const handleDownloadTemplate = () => {
    const data = [
      ["Nombre", "Email", "Password", "Telefono", "Programa"],
      ["Ana Ejemplo", "ana@example.com", "alumno123", "+52 5555555555", "Programa 1"],
      ["Juan Ejemplo", "juan@example.com", "alumno123", "+52 4444444444", "Programa 2"],
    ];
    const sheet = XLSX.utils.aoa_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Alumnos");
    XLSX.writeFile(workbook, "plantilla-alumnos.xlsx");
  };

  const parsedPreview = useMemo(() => {
    let filtered = parsedRows;
    if (previewFilter === "invalid") {
      filtered = parsedRows.filter((r) => r.invalidEmail);
    } else if (previewFilter === "new") {
      filtered = parsedRows.filter((r) => !r.exists && !r.invalidEmail);
    } else if (previewFilter === "existing") {
      filtered = parsedRows.filter((r) => r.exists);
    }
    return filtered.slice(0, 10);
  }, [parsedRows, previewFilter]);

  // Filtrar alumnos según búsqueda
  const filteredStudents = useMemo(() => {
    if (!searchQuery.trim()) {
      return students;
    }
    const query = searchQuery.toLowerCase().trim();
    return students.filter(
      (student) =>
        student.name.toLowerCase().includes(query) ||
        student.email.toLowerCase().includes(query) ||
        (student.program ?? "").toLowerCase().includes(query)
    );
  }, [students, searchQuery]);

  const parsePasswordFile = async (file: File) => {
    setPasswordResults([]);
    setParsedPasswordRows([]);
    setPasswordFileName(file.name);
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: "array" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!sheet) {
        toast.error("El archivo no tiene hojas válidas.");
        return;
      }
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
      const mapped = rows
        .map((row, idx) => {
          const email = String(row.Email ?? row.Correo ?? row.email ?? "").trim().toLowerCase();
          const password = String(
            row.Password ?? row.Contraseña ?? row.Contrasena ?? row.password ?? "",
          ).trim();
          const name = String(row.Nombre ?? row.name ?? row.Name ?? "").trim();

          if (!email) return null;
          const invalidEmail = !isValidEmail(email);

          return {
            row: idx + 2,
            name: name || "—",
            email,
            password: password || "alumno123",
            phone: "",
            program: "",
            missingProgram: false,
            exists: !invalidEmail,
            invalidEmail,
          };
        })
        .filter(Boolean) as ParsedStudentRow[];

      if (!mapped.length) {
        toast.error("No se encontraron filas válidas. Usa las columnas Email y Password.");
        return;
      }

      setParsedPasswordRows(mapped);
      const validCount = mapped.filter((s) => !s.invalidEmail).length;
      const invalidCount = mapped.filter((s) => s.invalidEmail).length;

      if (invalidCount > 0) {
        toast.error(
          `Archivo listo: ${validCount} válidos, ${invalidCount} emails inválidos`,
          { duration: 5000 }
        );
      } else {
        toast.success(`Archivo listo: ${validCount} contraseñas para actualizar`);
      }
    } catch (err) {
      console.error(err);
      toast.error("No se pudo leer el archivo. Verifica el formato .xlsx");
    }
  };

  const handleUpdatePasswords = async () => {
    if (!parsedPasswordRows.length) {
      toast.error("Primero carga un archivo con contraseñas.");
      return;
    }

    const validRows = parsedPasswordRows.filter((r) => !r.invalidEmail);
    if (!validRows.length) {
      toast.error("No hay emails válidos para actualizar.");
      return;
    }

    setUpdatingPasswords(true);
    try {
      const response = await fetch("/api/students/update-passwords", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          validRows.map((r) => ({
            email: r.email,
            newPassword: r.password,
          }))
        ),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Error al actualizar contraseñas");
      }

      const results: ImportResult[] = data.results.map((r: any) => ({
        row: validRows.find((v) => v.email === r.email)?.row ?? 0,
        email: r.email,
        status: r.success ? "created" : "error",
        message: r.success ? "Contraseña actualizada" : r.error,
      }));

      setPasswordResults(results);
      toast.success(
        `Actualización finalizada: ${data.summary.updated} actualizadas, ${data.summary.failed} errores.`
      );
    } catch (err: any) {
      console.error(err);
      toast.error(err.message || "Error al actualizar contraseñas");
    } finally {
      setUpdatingPasswords(false);
    }
  };

  const handleDeleteStudent = async (student: StudentUser) => {
    if (!student.id) return;
    if (!window.confirm(`¿Eliminar a ${student.name}? Se eliminarán sus inscripciones.`)) return;
    setDeletingStudentId(student.id);
    try {
      await deactivateStudent(student.id);
      toast.success("Alumno desactivado");
      await loadStudents();
    } catch (err) {
      console.error(err);
      toast.error("No se pudo eliminar al alumno");
    } finally {
      setDeletingStudentId(null);
    }
  };

  const handleOpenEditProfile = (student: StudentUser) => {
    setSelectedStudent(student);
    setNewEmail(student.email);
    setNewName(student.name || "");
    setNewPhone(student.phone || "");
    setNewProgram(student.program || "");
    setEditProfileModalOpen(true);
  };

  const handleOpenChangePassword = (student: StudentUser) => {
    setSelectedStudent(student);
    setNewPassword("ascensoUDEL");
    setChangePasswordModalOpen(true);
  };

  const handleUpdateProfile = async () => {
    if (!selectedStudent || !newEmail || !newName) {
      toast.error("El nombre y el email son obligatorios");
      return;
    }
    if (!newProgram) {
      toast.error("Selecciona un programa");
      return;
    }

    // Validar formato de email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(newEmail)) {
      toast.error("El email no tiene un formato válido");
      return;
    }

    setChangingPassword(true);
    try {
      const response = await fetch("/api/students/update-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId: selectedStudent.id,
          currentEmail: selectedStudent.email,
          newEmail: newEmail !== selectedStudent.email ? newEmail : undefined,
          newName: newName !== selectedStudent.name ? newName : undefined,
          newPhone: newPhone !== selectedStudent.phone ? newPhone : undefined,
          newProgram: newProgram !== selectedStudent.program ? newProgram : undefined,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Error al actualizar datos");
      }

      if (data.success) {
        const changes = [];
        if (newName !== selectedStudent.name) changes.push("nombre");
        if (newEmail !== selectedStudent.email) changes.push("email");
        if (newPhone !== selectedStudent.phone) changes.push("teléfono");
        if (newProgram !== selectedStudent.program) changes.push("programa");

        toast.success(
          changes.length > 0
            ? `${changes.join(", ")} actualizado${changes.length > 1 ? "s" : ""}`
            : "Datos actualizados"
        );
        setEditProfileModalOpen(false);
        setSelectedStudent(null);
        setNewEmail("");
        setNewName("");
        setNewPhone("");
        setNewProgram("");
        await loadStudents();
      } else {
        throw new Error(data.error || "Error al actualizar datos");
      }
    } catch (err: any) {
      console.error(err);
      toast.error(err.message || "No se pudo actualizar los datos");
    } finally {
      setChangingPassword(false);
    }
  };

  const handleChangePassword = async () => {
    if (!selectedStudent || !newPassword || newPassword.length < 6) {
      toast.error("La contraseña debe tener al menos 6 caracteres");
      return;
    }

    setChangingPassword(true);
    try {
      const response = await fetch("/api/students/update-passwords", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([
          {
            email: selectedStudent.email,
            newPassword: newPassword,
          },
        ]),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Error al cambiar la contraseña");
      }

      if (data.success && data.results?.[0]?.success) {
        toast.success("Contraseña actualizada correctamente");
        setChangePasswordModalOpen(false);
        setSelectedStudent(null);
        setNewPassword("ascensoUDEL");
      } else {
        throw new Error(data.results?.[0]?.error || "Error al cambiar la contraseña");
      }
    } catch (err: any) {
      console.error(err);
      toast.error(err.message || "No se pudo cambiar la contraseña");
    } finally {
      setChangingPassword(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Alumnos</p>
        <h1 className="text-2xl font-semibold text-slate-900">Panel de alumnos</h1>
        <p className="text-sm text-slate-600">
          Aquí podrás gestionar a tus alumnos, inscribirlos a grupos y revisar su progreso.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => loadStudents(false)}
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          disabled={loading}
        >
          {loading ? "Cargando..." : "Refrescar lista"}
        </button>
        <span className="text-sm text-slate-600">
          {isAdminTeacherRole(userRole)
            ? 'Lista de usuarios con rol estudiante (colección "users").'
            : "Solo se muestran los alumnos de los grupos que tienes asignados."}
        </span>
      </div>

      {isAdminTeacherRole(userRole) ? (
        <div className="space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">AdminTeacher</p>
              <h2 className="text-lg font-semibold text-slate-900">
                Crear alumnos con acceso por correo y contraseña
              </h2>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleDownloadTemplate}
                className="rounded-lg border border-blue-200 bg-white px-3 py-2 text-sm font-medium text-blue-700 shadow-sm hover:bg-blue-50"
              >
                Descargar plantilla Excel
              </button>
              <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-100">
                <input
                  type="file"
                  ref={fileInputRef}
                  accept=".xlsx,.xls"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) parseFile(file);
                  }}
                  className="hidden"
                />
                {fileName ? "Cambiar archivo" : "Cargar Excel"}
              </label>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <form
              onSubmit={handleCreateStudent}
              className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
            >
              <div>
                <p className="text-sm font-semibold text-slate-800">Crear alumno manualmente</p>
                <p className="text-xs text-slate-500">
                  Asigna un correo y contraseña para que pueda iniciar sesión.
                </p>
              </div>
            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">Nombre</label>
              <input
                value={newStudent.name}
                onChange={(e) => setNewStudent((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="Nombre del alumno"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>
              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-700">Teléfono / WhatsApp</label>
                <input
                  value={newStudent.phone}
                  onChange={(e) => setNewStudent((prev) => ({ ...prev, phone: e.target.value }))}
                  placeholder="+52..."
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-700">Correo</label>
                <input
                  type="email"
                  value={newStudent.email}
                  onChange={(e) => setNewStudent((prev) => ({ ...prev, email: e.target.value }))}
                  placeholder="correo@ejemplo.com"
                  required
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-700">Programa</label>
                <select
                  value={newStudent.program}
                  onChange={(e) => setNewStudent((prev) => ({ ...prev, program: e.target.value }))}
                  required
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                >
                  <option value="">{programLoading ? "Cargando..." : "Seleccionar"}</option>
                  {!programLoading && programOptions.length === 0 ? (
                    <option value="" disabled>
                      No hay programas
                    </option>
                  ) : null}
                  {programOptions.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-slate-500">
                  Administra los programas en la pestaña &quot;Programas&quot;.
                </p>
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-700">Contraseña</label>
                <input
                  type="password"
                  value={newStudent.password}
                  onChange={(e) => setNewStudent((prev) => ({ ...prev, password: e.target.value }))}
                  placeholder="Mínimo 6 caracteres"
                  required
                  minLength={6}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>
              <button
                type="submit"
                disabled={creating}
                className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {creating ? "Creando..." : "Crear alumno"}
              </button>
            </form>

            <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-slate-800">Cargar alumnos por Excel</p>
                  <p className="text-xs text-slate-500">Columnas: Nombre, Email, Password, Programa.</p>
                </div>
                <button
                  type="button"
                  onClick={handleImportStudents}
                  disabled={importing || !parsedRows.length}
                  className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {importing ? "Importando..." : "Importar alumnos"}
                </button>
              </div>
              {fileName ? (
                <div className="text-xs text-slate-600">
                  <p>
                    Archivo seleccionado: <span className="font-medium">{fileName}</span> (
                    {parsedRows.length} filas válidas)
                  </p>
                  {parsedRows.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setPreviewFilter("all")}
                        className={`rounded-md px-2 py-1 text-xs font-semibold transition ${
                          previewFilter === "all"
                            ? "bg-slate-200 text-slate-900"
                            : "text-slate-600 hover:bg-slate-100"
                        }`}
                      >
                        Todos ({parsedRows.length})
                      </button>
                      <button
                        type="button"
                        onClick={() => setPreviewFilter("new")}
                        className={`rounded-md px-2 py-1 text-xs font-semibold transition ${
                          previewFilter === "new"
                            ? "bg-emerald-100 text-emerald-800"
                            : "text-emerald-600 hover:bg-emerald-50"
                        }`}
                      >
                        Nuevos ({parsedRows.filter((r) => !r.exists && !r.invalidEmail).length})
                      </button>
                      <button
                        type="button"
                        onClick={() => setPreviewFilter("existing")}
                        className={`rounded-md px-2 py-1 text-xs font-semibold transition ${
                          previewFilter === "existing"
                            ? "bg-amber-100 text-amber-800"
                            : "text-amber-600 hover:bg-amber-50"
                        }`}
                      >
                        Ya existen ({parsedRows.filter((r) => r.exists).length})
                      </button>
                      {parsedRows.filter((r) => r.invalidEmail).length > 0 && (
                        <button
                          type="button"
                          onClick={() => setPreviewFilter("invalid")}
                          className={`rounded-md px-2 py-1 text-xs font-semibold transition ${
                            previewFilter === "invalid"
                              ? "bg-red-100 text-red-800"
                              : "text-red-600 hover:bg-red-50"
                          }`}
                        >
                          Emails inválidos ({parsedRows.filter((r) => r.invalidEmail).length})
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-xs text-slate-600">Sube un .xlsx con tu listado.</p>
              )}
              {parseError ? (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  {parseError}
                </div>
              ) : null}
              {parsedPreview.length ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-slate-700">
                      Vista previa{" "}
                      {previewFilter === "invalid"
                        ? `(${parsedPreview.length} emails inválidos)`
                        : previewFilter === "new"
                          ? `(${parsedPreview.length} nuevos)`
                          : previewFilter === "existing"
                            ? `(${parsedPreview.length} ya existen)`
                            : `(primeras ${parsedPreview.length} filas)`}
                    </p>
                    {previewFilter !== "all" && (
                      <button
                        type="button"
                        onClick={() => setPreviewFilter("all")}
                        className="text-xs text-slate-500 hover:text-slate-700"
                      >
                        Ver todos
                      </button>
                    )}
                  </div>
                  <div className="overflow-hidden rounded-lg border border-slate-200">
                    <div className="grid grid-cols-5 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-600">
                      <span>Nombre</span>
                      <span>Correo</span>
                      <span>Programa</span>
                      <span>Contraseña</span>
                      <span>Estado</span>
                    </div>
                    <div className="divide-y divide-slate-200 text-xs">
                      {parsedPreview.map((row) => (
                        <div key={row.row} className="grid grid-cols-5 px-3 py-2 text-slate-800">
                          <span>{row.name}</span>
                          <span className="truncate text-slate-600">{row.email}</span>
                          <span className="truncate text-slate-600">
                            {row.program || "—"}
                          </span>
                          <span className="font-mono text-slate-700">{row.password}</span>
                          <span
                            className={
                              row.invalidEmail || row.missingProgram
                                ? "font-semibold text-red-600"
                                : row.exists
                                  ? "font-semibold text-amber-600"
                                  : "font-semibold text-emerald-600"
                            }
                          >
                            {row.invalidEmail
                              ? "Email inválido"
                              : row.missingProgram
                                ? "Programa requerido"
                                : row.exists
                                  ? "Ya existe"
                                  : "Nuevo"}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}
              {importResults.length ? (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-slate-700">Resultados</p>
                  <div className="max-h-40 overflow-auto rounded-lg border border-slate-200">
                    <div className="grid grid-cols-3 bg-slate-50 px-3 py-2 text-[11px] font-semibold text-slate-600">
                      <span>Fila</span>
                      <span>Correo</span>
                      <span>Estado</span>
                    </div>
                    <div className="divide-y divide-slate-200 text-[11px]">
                      {importResults.map((res, idx) => (
                        <div key={`${res.email}-${idx}`} className="grid grid-cols-3 px-3 py-2">
                          <span>{res.row}</span>
                          <span className="truncate text-slate-700">{res.email}</span>
                          <span
                            className={
                              res.status === "created"
                                ? "font-semibold text-emerald-600"
                                : res.status === "skipped"
                                  ? "font-semibold text-amber-600"
                                  : "font-semibold text-red-600"
                            }
                          >
                            {res.status === "created"
                              ? "Creado"
                              : res.status === "skipped"
                                ? "Omitido (ya existía)"
                                : res.message || "Error"}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {isAdminTeacherRole(userRole) ? (
        <div className="space-y-4 rounded-xl border border-blue-200 bg-blue-50 p-4">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-blue-600">Actualización Masiva</p>
            <h2 className="text-lg font-semibold text-slate-900">
              Actualizar contraseñas de alumnos existentes
            </h2>
            <p className="text-sm text-slate-600">
              Sube un archivo Excel con Email y Password para actualizar las contraseñas de múltiples alumnos.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-blue-200 bg-white px-3 py-2 text-sm font-medium text-blue-700 shadow-sm hover:bg-blue-50">
              <input
                type="file"
                ref={passwordFileInputRef}
                accept=".xlsx,.xls"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) parsePasswordFile(file);
                }}
                className="hidden"
              />
              {passwordFileName ? "Cambiar archivo" : "Cargar Excel"}
            </label>
            <button
              type="button"
              onClick={handleUpdatePasswords}
              disabled={updatingPasswords || !parsedPasswordRows.length}
              className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {updatingPasswords ? "Actualizando..." : "Actualizar contraseñas"}
            </button>
          </div>

          {passwordFileName && (
            <div className="text-xs text-slate-600">
              <p>
                Archivo: <span className="font-medium">{passwordFileName}</span> (
                {parsedPasswordRows.length} filas)
              </p>
              {parsedPasswordRows.length > 0 && (
                <p className="mt-1">
                  <span className="font-semibold text-blue-600">
                    {parsedPasswordRows.filter((r) => !r.invalidEmail).length} válidos
                  </span>
                  {parsedPasswordRows.filter((r) => r.invalidEmail).length > 0 && (
                    <>
                      ,{" "}
                      <span className="font-semibold text-red-600">
                        {parsedPasswordRows.filter((r) => r.invalidEmail).length} inválidos
                      </span>
                    </>
                  )}
                </p>
              )}
            </div>
          )}

          {parsedPasswordRows.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-slate-700">
                Vista previa (primeras {Math.min(parsedPasswordRows.length, 5)} filas)
              </p>
              <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                <div className="grid grid-cols-3 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-600">
                  <span>Email</span>
                  <span>Nueva Contraseña</span>
                  <span>Estado</span>
                </div>
                <div className="divide-y divide-slate-200 text-xs">
                  {parsedPasswordRows.slice(0, 5).map((row) => (
                    <div key={row.row} className="grid grid-cols-3 px-3 py-2 text-slate-800">
                      <span className="truncate">{row.email}</span>
                      <span className="font-mono text-slate-700">{row.password}</span>
                      <span
                        className={
                          row.invalidEmail
                            ? "font-semibold text-red-600"
                            : "font-semibold text-blue-600"
                        }
                      >
                        {row.invalidEmail ? "Email inválido" : "Listo"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {passwordResults.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-slate-700">Resultados</p>
              <div className="max-h-40 overflow-auto rounded-lg border border-slate-200 bg-white">
                <div className="grid grid-cols-3 bg-slate-50 px-3 py-2 text-[11px] font-semibold text-slate-600">
                  <span>Fila</span>
                  <span>Email</span>
                  <span>Estado</span>
                </div>
                <div className="divide-y divide-slate-200 text-[11px]">
                  {passwordResults.map((res, idx) => (
                    <div key={`${res.email}-${idx}`} className="grid grid-cols-3 px-3 py-2">
                      <span>{res.row}</span>
                      <span className="truncate text-slate-700">{res.email}</span>
                      <span
                        className={
                          res.status === "created"
                            ? "font-semibold text-emerald-600"
                            : "font-semibold text-red-600"
                        }
                      >
                        {res.status === "created" ? res.message : res.message || "Error"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {loading ? (
        <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">
          Cargando alumnos...
        </div>
      ) : students.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">
          {isAdminTeacherRole(userRole)
            ? "No se encontraron alumnos con rol estudiante."
            : "Aún no tienes alumnos asignados a tus grupos."}
        </div>
      ) : (
        <div className="space-y-4">
          {/* Buscador de alumnos */}
          <div className="flex items-center gap-3">
            <div className="relative flex-1">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Buscar por nombre o email..."
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
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
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
              )}
            </div>
            <div className="text-sm text-slate-600">
              {filteredStudents.length} de {students.length} cargado{students.length !== 1 ? "s" : ""}
              {totalStudentsCount !== null && (
                <span className="text-slate-400"> ({totalStudentsCount} total)</span>
              )}
            </div>
          </div>

          {/* Tabla de alumnos */}
          {filteredStudents.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-slate-600">
              No se encontraron alumnos que coincidan con "{searchQuery}"
            </div>
          ) : (
            <>
            <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="grid grid-cols-6 gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs font-semibold text-slate-600">
            <span>Nombre</span>
            <span>Email</span>
            <span>Programa</span>
            <span>Inscrito</span>
            <span>Estado</span>
            <span className="text-right">Acciones</span>
          </div>
          <div className="divide-y divide-slate-200">
            {filteredStudents.map((s) => (
              <div
                key={s.id}
                className="grid grid-cols-6 gap-3 px-4 py-2 text-sm text-slate-800"
              >
                <span>{s.name}</span>
                <span className="text-slate-600 truncate break-words">{s.email}</span>
                <span className="text-slate-600 truncate">{s.program || "—"}</span>
                <span className="text-slate-600">N/D</span>
                <span className="font-medium capitalize text-green-600">
                  {s.estado || "Activo"}
                </span>
                <span className="flex justify-end gap-2">
                  {isAdminTeacherRole(userRole) ? (
                    <>
                      <button
                        type="button"
                        onClick={() => handleOpenEditProfile(s)}
                        className="rounded-lg border border-blue-200 px-3 py-1 text-xs font-semibold text-blue-600 transition hover:border-blue-400 hover:bg-blue-50"
                      >
                        Editar
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedStudentForSubmissions(s);
                          setSubmissionsModalOpen(true);
                        }}
                        className="rounded-lg border border-purple-200 px-3 py-1 text-xs font-semibold text-purple-600 transition hover:border-purple-400 hover:bg-purple-50"
                      >
                        Tareas
                      </button>
                      <button
                        type="button"
                        onClick={() => handleOpenChangePassword(s)}
                        className="rounded-lg border border-green-200 px-3 py-1 text-xs font-semibold text-green-600 transition hover:border-green-400 hover:bg-green-50"
                      >
                        Contraseña
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteStudent(s)}
                        disabled={deletingStudentId === s.id}
                        className="rounded-lg border border-red-200 px-3 py-1 text-xs font-semibold text-red-600 transition hover:border-red-400 disabled:cursor-not-allowed disabled:border-red-200 disabled:text-red-300"
                      >
                        {deletingStudentId === s.id ? "Eliminando..." : "Eliminar"}
                      </button>
                    </>
                  ) : (
                    <span className="text-xs text-slate-500">—</span>
                  )}
                </span>
              </div>
            ))}
          </div>
            </div>

            {/* Botón para cargar más estudiantes */}
            {hasMoreStudents && isAdminTeacherRole(userRole) && (
              <div className="mt-4 flex justify-center">
                <button
                  type="button"
                  onClick={() => loadStudents(true)}
                  disabled={loadingMore}
                  className="rounded-lg border border-blue-200 bg-blue-50 px-6 py-2 text-sm font-semibold text-blue-700 transition hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {loadingMore ? "Cargando..." : `Cargar más estudiantes`}
                </button>
              </div>
            )}
            </>
          )}
        </div>
      )}

      {/* Modal para editar perfil del alumno */}
      {editProfileModalOpen && selectedStudent && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black bg-opacity-50 px-4 py-6">
          <div className="w-full max-w-md max-h-[calc(100vh-3rem)] overflow-y-auto rounded-xl bg-white p-6 shadow-2xl">
            <div className="mb-4">
              <h2 className="text-xl font-semibold text-slate-900">
                Editar Perfil
              </h2>
              <p className="text-sm text-slate-600">
                Alumno: <span className="font-medium">{selectedStudent.name}</span>
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Nombre completo
                </label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Nombre del alumno"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Email
                </label>
                <input
                  type="email"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="correo@ejemplo.com"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
                <p className="mt-1 text-xs text-slate-500">
                  El email debe tener un formato válido
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Teléfono
                </label>
                <input
                  type="text"
                  value={newPhone}
                  onChange={(e) => setNewPhone(e.target.value)}
                  placeholder="Número de teléfono (opcional)"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Programa
                </label>
                <select
                  value={newProgram}
                  onChange={(e) => setNewProgram(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                >
                  <option value="">{programLoading ? "Cargando..." : "Seleccionar"}</option>
                  {!programLoading && programOptions.length === 0 ? (
                    <option value="" disabled>
                      No hay programas
                    </option>
                  ) : null}
                  {programOptions.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-slate-500">
                  Administra los programas en la pestaña &quot;Programas&quot;.
                </p>
              </div>

              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setEditProfileModalOpen(false);
                    setSelectedStudent(null);
                    setNewEmail("");
                    setNewName("");
                    setNewPhone("");
                  }}
                  disabled={changingPassword}
                  className="flex-1 rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={handleUpdateProfile}
                  disabled={changingPassword || !newEmail || !newName}
                  className="flex-1 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {changingPassword ? "Guardando..." : "Guardar cambios"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal para cambiar contraseña */}
      {changePasswordModalOpen && selectedStudent && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black bg-opacity-50 px-4 py-6">
          <div className="w-full max-w-md max-h-[calc(100vh-3rem)] overflow-y-auto rounded-xl bg-white p-6 shadow-2xl">
            <div className="mb-4">
              <h2 className="text-xl font-semibold text-slate-900">
                Cambiar Contraseña
              </h2>
              <p className="text-sm text-slate-600">
                Alumno: <span className="font-medium">{selectedStudent.name}</span>
              </p>
              <p className="text-xs text-slate-500 mt-1">
                Email: {selectedStudent.email}
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Nueva Contraseña
                </label>
                <input
                  type="text"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Mínimo 6 caracteres"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
                <p className="mt-1 text-xs text-slate-500">
                  La contraseña debe tener al menos 6 caracteres
                </p>
              </div>

              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setChangePasswordModalOpen(false);
                    setSelectedStudent(null);
                    setNewPassword("ascensoUDEL");
                  }}
                  disabled={changingPassword}
                  className="flex-1 rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={handleChangePassword}
                  disabled={changingPassword || !newPassword || newPassword.length < 6}
                  className="flex-1 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {changingPassword ? "Cambiando..." : "Cambiar contraseña"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal para ver tareas del alumno */}
      {submissionsModalOpen && selectedStudentForSubmissions && (
        <StudentAllSubmissionsModal
          studentId={selectedStudentForSubmissions.id}
          studentName={selectedStudentForSubmissions.name}
          studentEmail={selectedStudentForSubmissions.email}
          isOpen={submissionsModalOpen}
          onClose={() => {
            setSubmissionsModalOpen(false);
            setSelectedStudentForSubmissions(null);
          }}
        />
      )}
    </div>
  );
}
