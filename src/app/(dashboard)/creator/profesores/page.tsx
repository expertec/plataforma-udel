"use client";

import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { User, onAuthStateChanged } from "firebase/auth";
import { useRouter } from "next/navigation";
import { auth } from "@/lib/firebase/client";
import { resolveUserRole } from "@/lib/firebase/roles";
import {
  createTeacherAccount,
  deactivateTeacher,
  getTeacherUsers,
  TeacherUser,
} from "@/lib/firebase/teachers-service";

export default function ProfesoresPage() {
  const [teachers, setTeachers] = useState<TeacherUser[]>([]);
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
  const [changingPassword, setChangingPassword] = useState(false);
  const [updatingProfile, setUpdatingProfile] = useState(false);

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
        if (role !== "adminTeacher") {
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
    if (!isAdminTeacher) return;
    loadTeachers();
  }, [isAdminTeacher, loadTeachers]);

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
      await loadTeachers();
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
      await loadTeachers();
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

    setUpdatingProfile(true);
    try {
      const response = await fetch("/api/teachers/update-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teacherId: selectedTeacher.id,
          currentEmail: selectedTeacher.email,
          newEmail: newEmail.trim().toLowerCase() !== selectedTeacher.email.toLowerCase() ? newEmail.trim() : undefined,
          newName: newName.trim() !== selectedTeacher.name ? newName.trim() : undefined,
          newPhone: newPhone.trim() !== (selectedTeacher.phone || "") ? newPhone.trim() : undefined,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Error al actualizar perfil");
      }

      toast.success("Perfil actualizado correctamente");
      setEditProfileModalOpen(false);
      await loadTeachers();
    } catch (err: any) {
      console.error(err);
      toast.error(err.message || "No se pudo actualizar el perfil");
    } finally {
      setUpdatingProfile(false);
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
    } catch (err: any) {
      console.error(err);
      toast.error(err.message || "No se pudo cambiar la contraseña");
    } finally {
      setChangingPassword(false);
    }
  };

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
        </p>
      </div>

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

      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-600">Listado de profesores y AdminTeacher.</p>
        <button
          type="button"
          onClick={loadTeachers}
          disabled={loading}
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed"
        >
          {loading ? "Actualizando..." : "Refrescar"}
        </button>
      </div>

      {loading ? (
        <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">
          Cargando profesores...
        </div>
      ) : teachers.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">
          No se encontraron profesores registrados.
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
            {teachers.map((teacher) => (
              <div
                key={teacher.id}
                className="grid grid-cols-[1.3fr_2fr_1fr_0.95fr_0.8fr_1.5fr] gap-3 px-4 py-2 text-sm text-slate-800"
              >
                <span>{teacher.name}</span>
                <span className="text-slate-600 break-words">{teacher.email}</span>
                <span className="text-slate-600">{teacher.phone || "—"}</span>
                <span className="font-medium capitalize text-blue-700">
                  {teacher.role === "adminTeacher" ? "AdminTeacher" : "Profesor"}
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

      {/* Modal para editar perfil */}
      {editProfileModalOpen && selectedTeacher && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
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
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setEditProfileModalOpen(false)}
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
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
