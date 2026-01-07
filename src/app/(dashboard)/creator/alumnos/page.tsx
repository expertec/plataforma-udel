"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import * as XLSX from "xlsx";
import { User, onAuthStateChanged } from "firebase/auth";
import { auth } from "@/lib/firebase/client";
import { resolveUserRole, UserRole } from "@/lib/firebase/roles";
import {
  createStudentAccount,
  deactivateStudent,
  getStudentUsers,
  StudentUser,
} from "@/lib/firebase/students-service";
import { getGroupStudents, getGroupsForTeacher } from "@/lib/firebase/groups-service";

type ParsedStudentRow = {
  row: number;
  name: string;
  email: string;
  password: string;
  phone?: string;
};

type ImportResult = {
  row: number;
  email: string;
  status: "ok" | "error";
  message?: string;
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
  const [newStudent, setNewStudent] = useState({ name: "", email: "", password: "", phone: "" });
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState<User | null>(auth.currentUser);
  const [userRole, setUserRole] = useState<UserRole | null>(null);
  const [deletingStudentId, setDeletingStudentId] = useState<string | null>(null);

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

  const loadStudents = useCallback(async () => {
    const userId = currentUser?.uid;
    if (!userId || !userRole) return;
    setLoading(true);
    try {
      if (userRole === "adminTeacher") {
        const data = await getStudentUsers(200);
        setStudents(data);
        return;
      }
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
    } catch (err) {
      console.error(err);
      toast.error(
        userRole === "adminTeacher"
          ? "No se pudieron cargar los alumnos (users)"
          : "No se pudieron cargar los alumnos de tus grupos",
      );
    } finally {
      setLoading(false);
    }
  }, [currentUser?.uid, userRole]);

  useEffect(() => {
    loadStudents();
  }, [loadStudents]);

  const handleCreateStudent = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!newStudent.email || !newStudent.password) {
      toast.error("Completa email y contraseña");
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
      });
      toast.success("Alumno creado con acceso por correo/contraseña");
      setNewStudent({ name: "", email: "", password: "", phone: "" });
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
          if (!email) return null;
          return {
            row: idx + 2,
            name: name || "Alumno",
            email,
            password: password || "alumno123",
            phone: phone || "",
          };
        })
        .filter(Boolean) as ParsedStudentRow[];
      if (!mapped.length) {
        setParseError("No se encontraron filas válidas. Usa las columnas Nombre, Email y Password.");
        return;
      }
      setParsedRows(mapped);
      toast.success(`Archivo listo (${mapped.length} alumnos detectados)`);
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
      try {
        await createStudentAccount({
          name: row.name,
          email: row.email,
          password: row.password,
          createdBy: currentUser?.uid ?? null,
          phone: row.phone,
        });
        results.push({ row: row.row, email: row.email, status: "ok" });
      } catch (err: unknown) {
        console.error(err);
        const code = (err as { code?: string })?.code ?? "";
        const message =
          code === "auth/email-already-in-use"
            ? "Correo ya existente"
            : (err as { message?: string })?.message || "No se pudo crear";
        results.push({ row: row.row, email: row.email, status: "error", message });
      }
    }
    setImportResults(results);
    setImporting(false);
    await loadStudents();
    toast.success("Importación finalizada (revisa los resultados por fila).");
  };

  const handleDownloadTemplate = () => {
    const data = [
      ["Nombre", "Email", "Password", "Telefono"],
      ["Ana Ejemplo", "ana@example.com", "alumno123", "+52 5555555555"],
      ["Juan Ejemplo", "juan@example.com", "alumno123", "+52 4444444444"],
    ];
    const sheet = XLSX.utils.aoa_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Alumnos");
    XLSX.writeFile(workbook, "plantilla-alumnos.xlsx");
  };

  const parsedPreview = useMemo(() => parsedRows.slice(0, 5), [parsedRows]);

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
          onClick={loadStudents}
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          disabled={loading}
        >
          {loading ? "Cargando..." : "Refrescar lista"}
        </button>
        <span className="text-sm text-slate-600">
          {userRole === "adminTeacher"
            ? 'Lista de usuarios con rol estudiante (colección "users").'
            : "Solo se muestran los alumnos de los grupos que tienes asignados."}
        </span>
      </div>

      {userRole === "adminTeacher" ? (
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
                  <p className="text-xs text-slate-500">Columnas: Nombre, Email, Password.</p>
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
                <p className="text-xs text-slate-600">
                  Archivo seleccionado: <span className="font-medium">{fileName}</span> ({parsedRows.length} filas válidas)
                </p>
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
                  <p className="text-xs font-semibold text-slate-700">Vista previa (primeras filas)</p>
                  <div className="overflow-hidden rounded-lg border border-slate-200">
                    <div className="grid grid-cols-3 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-600">
                      <span>Nombre</span>
                      <span>Correo</span>
                      <span>Contraseña</span>
                    </div>
                    <div className="divide-y divide-slate-200 text-xs">
                      {parsedPreview.map((row) => (
                        <div key={row.row} className="grid grid-cols-3 px-3 py-2 text-slate-800">
                          <span>{row.name}</span>
                          <span className="truncate text-slate-600">{row.email}</span>
                          <span className="font-mono text-slate-700">{row.password}</span>
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
                              res.status === "ok"
                                ? "font-semibold text-emerald-600"
                                : "font-semibold text-red-600"
                            }
                          >
                            {res.status === "ok" ? "Creado" : res.message || "Error"}
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

      {loading ? (
        <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">
          Cargando alumnos...
        </div>
      ) : students.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">
          {userRole === "adminTeacher"
            ? "No se encontraron alumnos con rol estudiante."
            : "Aún no tienes alumnos asignados a tus grupos."}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="grid grid-cols-5 gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs font-semibold text-slate-600">
            <span>Nombre</span>
            <span>Email</span>
            <span>Inscrito</span>
            <span>Estado</span>
            <span className="text-right">Acciones</span>
          </div>
          <div className="divide-y divide-slate-200">
            {students.map((s) => (
              <div
                key={s.id}
                className="grid grid-cols-5 gap-3 px-4 py-2 text-sm text-slate-800"
              >
                <span>{s.name}</span>
                <span className="text-slate-600 truncate break-words">{s.email}</span>
                <span className="text-slate-600">N/D</span>
                <span className="font-medium capitalize text-green-600">
                  {s.estado || "Activo"}
                </span>
                <span className="flex justify-end">
                  {userRole === "adminTeacher" ? (
                    <button
                      type="button"
                      onClick={() => handleDeleteStudent(s)}
                      disabled={deletingStudentId === s.id}
                      className="rounded-lg border border-red-200 px-3 py-1 text-xs font-semibold text-red-600 transition hover:border-red-400 disabled:cursor-not-allowed disabled:border-red-200 disabled:text-red-300"
                    >
                      {deletingStudentId === s.id ? "Eliminando..." : "Eliminar"}
                    </button>
                  ) : (
                    <span className="text-xs text-slate-500">—</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
