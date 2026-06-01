"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { User, onAuthStateChanged, updateProfile } from "firebase/auth";
import { auth } from "@/lib/firebase/client";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/firestore";
import { getDownloadURL, getStorage, ref, uploadBytes } from "firebase/storage";
import toast from "react-hot-toast";
import { v4 as uuidv4 } from "uuid";
import {
  isDirectorRole,
  isAdminTeacherRole,
  isCampusCoordinatorRole,
  resolveUserRole,
  type UserRole,
} from "@/lib/firebase/roles";
import {
  normalizeTeacherProfessionalProfile,
  normalizeTeacherProfileTextList,
} from "@/lib/teachers/profile";

export default function PerfilPage() {
  const [user, setUser] = useState<User | null>(auth.currentUser);
  const [userRole, setUserRole] = useState<UserRole | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [profileHeadline, setProfileHeadline] = useState("");
  const [profileBio, setProfileBio] = useState("");
  const [profileStrengths, setProfileStrengths] = useState("");
  const [profileExpertiseTopics, setProfileExpertiseTopics] = useState("");
  const [profileCertifications, setProfileCertifications] = useState("");
  const [savingCv, setSavingCv] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const unsub = onAuthStateChanged(auth, async (current) => {
      setUser(current);
      setDisplayName(current?.displayName ?? "");
      setPhotoPreview(current?.photoURL ?? null);
      if (!current) {
        setUserRole(null);
        setProfileHeadline("");
        setProfileBio("");
        setProfileStrengths("");
        setProfileExpertiseTopics("");
        setProfileCertifications("");
        return;
      }

      try {
        const [role, userSnap] = await Promise.all([
          resolveUserRole(current),
          getDoc(doc(db, "users", current.uid)),
        ]);
        if (cancelled) return;

        setUserRole(role);
        const userData = userSnap.data() ?? {};
        const teacherProfile = normalizeTeacherProfessionalProfile(userData.teacherProfile);
        const fallbackNameFromDoc =
          typeof userData.displayName === "string"
            ? userData.displayName.trim()
            : typeof userData.name === "string"
              ? userData.name.trim()
              : "";
        const fallbackPhotoFromDoc =
          typeof userData.photoURL === "string" && userData.photoURL.trim().length > 0
            ? userData.photoURL.trim()
            : null;

        if (!(current.displayName ?? "").trim() && fallbackNameFromDoc) {
          setDisplayName(fallbackNameFromDoc);
        }
        if (!current.photoURL && fallbackPhotoFromDoc) {
          setPhotoPreview(fallbackPhotoFromDoc);
        }
        setProfileHeadline(teacherProfile.headline);
        setProfileBio(teacherProfile.bio);
        setProfileStrengths(teacherProfile.strengths.join("\n"));
        setProfileExpertiseTopics(teacherProfile.expertiseTopics.join("\n"));
        setProfileCertifications(teacherProfile.certifications.join("\n"));
      } catch (error) {
        console.error("No se pudo cargar el perfil docente:", error);
      }
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  const fallbackName = useMemo(() => user?.displayName ?? "Profesor", [user]);
  const email = user?.email ?? "Sin correo registrado";
  const roleLabel = useMemo(() => {
    if (userRole === "superAdminTeacher") return "SuperAdminTeacher";
    if (userRole === "adminTeacher") return "AdminTeacher";
    if (isDirectorRole(userRole)) return "Director de plantel";
    if (isCampusCoordinatorRole(userRole)) return "Coordinador de plantel";
    return "Profesor";
  }, [userRole]);
  const parsedStrengths = useMemo(
    () => normalizeTeacherProfileTextList(profileStrengths),
    [profileStrengths],
  );
  const parsedExpertiseTopics = useMemo(
    () => normalizeTeacherProfileTextList(profileExpertiseTopics),
    [profileExpertiseTopics],
  );
  const parsedCertifications = useMemo(
    () => normalizeTeacherProfileTextList(profileCertifications),
    [profileCertifications],
  );

  const handleFile = (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Solo se permiten imágenes");
      return;
    }
    const maxSizeMb = 5;
    if (file.size > maxSizeMb * 1024 * 1024) {
      toast.error(`La imagen debe pesar menos de ${maxSizeMb}MB`);
      return;
    }
    setPhotoFile(file);
    const url = URL.createObjectURL(file);
    setPhotoPreview(url);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) {
      toast.error("No hay sesión activa");
      return;
    }
    const trimmedName = displayName.trim();
    if (!trimmedName) {
      toast.error("El nombre no puede estar vacío");
      return;
    }
    setSaving(true);
    try {
      let photoURL = user.photoURL ?? null;
      if (photoFile) {
        const storage = getStorage();
        const ext = photoFile.name.split(".").pop() || "jpg";
        const storageRef = ref(storage, `profile-photos/${user.uid}/${uuidv4()}.${ext.toLowerCase()}`);
        const snap = await uploadBytes(storageRef, photoFile, { contentType: photoFile.type });
        photoURL = await getDownloadURL(snap.ref);
      }

      await updateProfile(user, { displayName: trimmedName, photoURL: photoURL ?? undefined });
      await setDoc(
        doc(db, "users", user.uid),
        { name: trimmedName, displayName: trimmedName, photoURL: photoURL ?? null },
        { merge: true },
      );
      setUser({ ...user, displayName: trimmedName, photoURL: photoURL ?? undefined } as User);
      toast.success("Perfil actualizado");
    } catch (err) {
      console.error(err);
      toast.error("No se pudo actualizar el perfil");
    } finally {
      setSaving(false);
    }
  };

  const handleSaveCv = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) {
      toast.error("No hay sesión activa");
      return;
    }

    setSavingCv(true);
    try {
      const token = await user.getIdToken();
      const response = await fetch("/api/teachers/update-profile", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          teacherId: user.uid,
          teacherProfile: {
            headline: profileHeadline.trim(),
            bio: profileBio.trim(),
            strengths: parsedStrengths,
            expertiseTopics: parsedExpertiseTopics,
            certifications: parsedCertifications,
          },
        }),
      });

      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(data.error || "No se pudo actualizar el CV docente");
      }

      toast.success("CV docente actualizado");
    } catch (error) {
      console.error(error);
      toast.error(
        error instanceof Error ? error.message : "No se pudo actualizar el CV docente",
      );
    } finally {
      setSavingCv(false);
    }
  };

  return (
    <div className="space-y-6 text-slate-900">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.25em] text-slate-500">Perfil</p>
          <h1 className="text-3xl font-semibold text-slate-900">Perfil del profesor</h1>
          <p className="text-sm text-slate-600">
            Actualiza tus datos y revisa tu información básica de cuenta.
          </p>
        </div>
        <Link
          href="/creator"
          className="inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-800 shadow-sm transition hover:border-blue-500 hover:text-blue-700"
        >
          ← Volver al dashboard
        </Link>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <section className="flex items-center gap-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-full border border-slate-200 bg-slate-50">
            {photoPreview ? (
              <Image
                src={photoPreview}
                alt={displayName || fallbackName}
                width={80}
                height={80}
                className="h-full w-full object-cover"
                unoptimized
              />
            ) : (
              <span className="text-xl font-semibold text-slate-800">
                {(displayName || fallbackName).charAt(0).toUpperCase()}
              </span>
            )}
          </div>
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold text-slate-900">{displayName || fallbackName}</h2>
              <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700">
                {roleLabel}
              </span>
            </div>
            <p className="text-sm text-slate-600">{email}</p>
            <p className="text-xs text-slate-500">
              ID de usuario: <span className="font-mono">{user?.uid ?? "N/D"}</span>
            </p>
          </div>
        </section>

        <section className="space-y-3 rounded-2xl border border-slate-200 bg-gradient-to-br from-indigo-50 via-white to-white p-5 shadow-sm">
          <h3 className="text-lg font-semibold text-slate-900">Accesos rápidos</h3>
          <div className="grid gap-3">
            <Link
              href="/creator/cursos"
              className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-800 transition hover:border-blue-300"
            >
              Gestionar cursos
              <span className="text-blue-600">→</span>
            </Link>
            <Link
              href="/creator/grupos"
              className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-800 transition hover:border-blue-300"
            >
              Ver grupos y cohortes
              <span className="text-blue-600">→</span>
            </Link>
            <Link
              href="/creator/alumnos"
              className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-800 transition hover:border-blue-300"
            >
              Panel de alumnos
              <span className="text-blue-600">→</span>
            </Link>
          </div>
        </section>
      </div>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="text-lg font-semibold text-slate-900">Información de la cuenta</h3>
        <form onSubmit={handleSave} className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-1 space-y-2">
            <label className="text-sm font-medium text-slate-800">Nombre completo</label>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="Tu nombre"
            />
          </div>
          <div className="sm:col-span-1 space-y-2">
            <label className="text-sm font-medium text-slate-800">Foto de perfil</label>
            <label
              className="flex h-28 cursor-pointer items-center justify-center gap-3 rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 px-3 text-sm text-slate-600 transition hover:border-blue-400"
            >
              <span role="img" aria-label="upload">📤</span>
              <span>{photoFile ? "Cambiar foto" : "Subir foto"}</span>
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
              />
            </label>
            <p className="text-xs text-slate-500">JPEG/PNG hasta 5MB.</p>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <dt className="text-xs uppercase tracking-[0.2em] text-slate-500">Correo</dt>
            <dd className="text-sm font-semibold text-slate-900">{email}</dd>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <dt className="text-xs uppercase tracking-[0.2em] text-slate-500">UID</dt>
            <dd className="font-mono text-sm text-slate-800">{user?.uid ?? "N/D"}</dd>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <dt className="text-xs uppercase tracking-[0.2em] text-slate-500">Proveedor</dt>
            <dd className="text-sm font-semibold text-slate-900">
              {user?.providerData?.[0]?.providerId ?? "Desconocido"}
            </dd>
          </div>
          <div className="sm:col-span-2 flex justify-end">
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {saving ? "Guardando..." : "Guardar cambios"}
            </button>
          </div>
        </form>
      </section>

      <section className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <form
          onSubmit={handleSaveCv}
          className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
        >
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">CV docente</p>
            <h3 className="text-lg font-semibold text-slate-900">
              Tu perfil profesional
            </h3>
            <p className="text-sm text-slate-600">
              Agrega fortalezas, temas que dominas, semblanza y logros para mantener tu ficha actualizada.
            </p>
          </div>

          <div className="mt-4 grid gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-800">Título profesional</label>
              <input
                value={profileHeadline}
                onChange={(e) => setProfileHeadline(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="Ej. Mentor en IA educativa y diseño instruccional"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-800">Semblanza</label>
              <textarea
                value={profileBio}
                onChange={(e) => setProfileBio(e.target.value)}
                rows={6}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="Cuéntanos tu experiencia, enfoque de enseñanza y trayectoria."
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-800">Fortalezas</label>
              <textarea
                value={profileStrengths}
                onChange={(e) => setProfileStrengths(e.target.value)}
                rows={4}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder={"Una por línea\nEj. Explicación clara\nSeguimiento cercano"}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-800">Temas que dominas</label>
              <textarea
                value={profileExpertiseTopics}
                onChange={(e) => setProfileExpertiseTopics(e.target.value)}
                rows={4}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder={"Uno por línea\nEj. Prompt engineering\nPlaneación didáctica"}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-800">Certificaciones o logros</label>
              <textarea
                value={profileCertifications}
                onChange={(e) => setProfileCertifications(e.target.value)}
                rows={4}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder={"Uno por línea\nEj. Google Educator Nivel 2"}
              />
            </div>

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={savingCv}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {savingCv ? "Guardando CV..." : "Guardar CV"}
              </button>
            </div>
          </div>
        </form>

        <section className="rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-50 via-white to-white p-5 shadow-sm">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Vista previa</p>
          <h3 className="mt-1 text-lg font-semibold text-slate-900">
            Cómo se ve tu ficha
          </h3>

          <div className="mt-4 space-y-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Título
              </p>
              <p className="mt-1 text-sm text-slate-800">
                {profileHeadline.trim() || "Sin título profesional definido."}
              </p>
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Semblanza
              </p>
              <p className="mt-1 whitespace-pre-line text-sm leading-6 text-slate-700">
                {profileBio.trim() || "Aún no has agregado una semblanza profesional."}
              </p>
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Fortalezas
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {parsedStrengths.length > 0 ? (
                  parsedStrengths.map((item) => (
                    <span
                      key={item}
                      className="rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700"
                    >
                      {item}
                    </span>
                  ))
                ) : (
                  <span className="text-sm text-slate-500">
                    Sin fortalezas capturadas.
                  </span>
                )}
              </div>
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Temas que dominas
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {parsedExpertiseTopics.length > 0 ? (
                  parsedExpertiseTopics.map((item) => (
                    <span
                      key={item}
                      className="rounded-full bg-violet-50 px-3 py-1 text-xs font-medium text-violet-700"
                    >
                      {item}
                    </span>
                  ))
                ) : (
                  <span className="text-sm text-slate-500">
                    Sin temas capturados.
                  </span>
                )}
              </div>
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Certificaciones o logros
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {parsedCertifications.length > 0 ? (
                  parsedCertifications.map((item) => (
                    <span
                      key={item}
                      className="rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700"
                    >
                      {item}
                    </span>
                  ))
                ) : (
                  <span className="text-sm text-slate-500">
                    Sin certificaciones capturadas.
                  </span>
                )}
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-4 text-xs leading-5 text-slate-600">
              {isAdminTeacherRole(userRole)
                ? "Como admin docente, sigues pudiendo editar CVs desde el panel de Profesores."
                : "Este CV es autoservicio: tú actualizas tus fortalezas, experiencia y temas dominados desde aquí."}
            </div>
          </div>
        </section>
      </section>
    </div>
  );
}
