"use client";

import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from "react";
import { User, onAuthStateChanged } from "firebase/auth";
import { auth } from "@/lib/firebase/client";
import { Course, getCourses } from "@/lib/firebase/courses-service";
import { Group, getGroupsForTeacher } from "@/lib/firebase/groups-service";
import { resolveUserRole, UserRole, isAdminTeacherRole } from "@/lib/firebase/roles";

type TeacherDataContextType = {
  currentUser: User | null;
  userRole: UserRole | null;
  courses: Course[];
  groups: Group[];
  loading: boolean;
  error: string | null;
  // Estadísticas calculadas
  publishedCoursesCount: number;
  activeGroupsCount: number;
  totalStudentsCount: number;
  // Métodos
  refreshCourses: () => Promise<void>;
  refreshGroups: () => Promise<void>;
  refreshAll: () => Promise<void>;
  invalidateCache: () => void;
};

const TeacherDataContext = createContext<TeacherDataContextType | undefined>(undefined);

// Tiempo de expiración del caché (5 minutos)
const CACHE_TTL = 5 * 60 * 1000;

type CacheData = {
  courses: Course[];
  groups: Group[];
  timestamp: number;
};

export function TeacherDataProvider({ children }: { children: ReactNode }) {
  const [currentUser, setCurrentUser] = useState<User | null>(auth.currentUser);
  const [userRole, setUserRole] = useState<UserRole | null>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cacheTimestamp, setCacheTimestamp] = useState<number>(0);

  // Verificar si el caché es válido
  const isCacheValid = useCallback(() => {
    return cacheTimestamp > 0 && Date.now() - cacheTimestamp < CACHE_TTL;
  }, [cacheTimestamp]);

  // Cargar cursos con caché
  const refreshCourses = useCallback(async () => {
    if (!currentUser || !userRole) return;

    try {
      const teacherId = isAdminTeacherRole(userRole) ? undefined : currentUser.uid;
      // Límite razonable para caché (más que el dashboard pero no todos)
      const data = await getCourses(teacherId, 50);
      setCourses(data);
    } catch (err) {
      console.error("Error cargando cursos:", err);
      setError("No se pudieron cargar los cursos");
    }
  }, [currentUser, userRole]);

  // Cargar grupos con caché
  const refreshGroups = useCallback(async () => {
    if (!currentUser) return;

    try {
      // Límite razonable para caché
      const data = await getGroupsForTeacher(currentUser.uid, 50);
      setGroups(data);
    } catch (err) {
      console.error("Error cargando grupos:", err);
      setError("No se pudieron cargar los grupos");
    }
  }, [currentUser]);

  // Refrescar todo
  const refreshAll = useCallback(async () => {
    if (!currentUser || !userRole) return;

    setLoading(true);
    setError(null);

    try {
      await Promise.all([refreshCourses(), refreshGroups()]);
      setCacheTimestamp(Date.now());
    } catch (err) {
      console.error("Error refrescando datos:", err);
      setError("No se pudieron cargar los datos");
    } finally {
      setLoading(false);
    }
  }, [currentUser, userRole, refreshCourses, refreshGroups]);

  // Invalidar caché manualmente (útil después de crear/editar/eliminar)
  const invalidateCache = useCallback(() => {
    setCacheTimestamp(0);
  }, []);

  // Escuchar cambios de autenticación
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      setCurrentUser(user);

      if (!user) {
        setUserRole(null);
        setCourses([]);
        setGroups([]);
        setLoading(false);
        setCacheTimestamp(0);
        return;
      }

      try {
        const role = await resolveUserRole(user);
        setUserRole(role);
      } catch (err) {
        console.error("Error obteniendo rol:", err);
        setUserRole(null);
      }
    });

    return () => unsub();
  }, []);

  // Cargar datos cuando el usuario y rol estén disponibles
  useEffect(() => {
    if (currentUser && userRole && !isCacheValid()) {
      refreshAll();
    }
  }, [currentUser, userRole, isCacheValid, refreshAll]);

  // Estadísticas calculadas
  const publishedCoursesCount = courses.filter((c) => c.isPublished).length;
  const activeGroupsCount = groups.filter((g) => g.status === "active").length;
  const totalStudentsCount = groups.reduce((acc, g) => acc + (g.studentsCount ?? 0), 0);

  return (
    <TeacherDataContext.Provider
      value={{
        currentUser,
        userRole,
        courses,
        groups,
        loading,
        error,
        publishedCoursesCount,
        activeGroupsCount,
        totalStudentsCount,
        refreshCourses,
        refreshGroups,
        refreshAll,
        invalidateCache,
      }}
    >
      {children}
    </TeacherDataContext.Provider>
  );
}

export function useTeacherData() {
  const context = useContext(TeacherDataContext);
  if (context === undefined) {
    throw new Error("useTeacherData debe usarse dentro de un TeacherDataProvider");
  }
  return context;
}
