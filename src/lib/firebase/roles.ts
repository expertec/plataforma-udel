import { User } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { db } from "./firestore";

export type UserRole =
  | "teacher"
  | "student"
  | "adminTeacher"
  | "superAdminTeacher"
  | "coordinadorPlantel"
  | "director";

export type UserExtraRole = "director";

export type UserRoleAccessProfile = {
  role: UserRole | null;
  extraRoles: UserExtraRole[];
  plantelIds: string[];
  plantelNames: string[];
};

const allowedRoles: UserRole[] = [
  "teacher",
  "student",
  "adminTeacher",
  "superAdminTeacher",
  "coordinadorPlantel",
  "director",
];

const allowedExtraRoles: UserExtraRole[] = ["director"];

function asUniqueStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      ),
    ),
  );
}

function normalizeExtraRoles(value: unknown): UserExtraRole[] {
  const roles = asUniqueStringArray(value);
  const hasLegacyDirector =
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).director === true;
  const merged = hasLegacyDirector ? [...roles, "director"] : roles;
  return merged.filter((role): role is UserExtraRole =>
    allowedExtraRoles.includes(role as UserExtraRole),
  );
}

function mergeExtraRoles(left: UserExtraRole[], right: UserExtraRole[]): UserExtraRole[] {
  return Array.from(new Set([...left, ...right]));
}

function getPlantelIdsFromData(data: Record<string, unknown> | undefined): string[] {
  if (!data) return [];
  const explicit = asUniqueStringArray(data.plantelIds);
  if (explicit.length > 0) return explicit;
  const legacyPlantelId =
    typeof data.plantelId === "string" && data.plantelId.trim().length > 0
      ? data.plantelId.trim()
      : "";
  return legacyPlantelId ? [legacyPlantelId] : [];
}

function getPlantelNamesFromData(data: Record<string, unknown> | undefined): string[] {
  if (!data) return [];
  const explicit = asUniqueStringArray(data.plantelNames);
  if (explicit.length > 0) return explicit;
  const legacyPlantelName =
    typeof data.plantelName === "string" && data.plantelName.trim().length > 0
      ? data.plantelName.trim()
      : "";
  return legacyPlantelName ? [legacyPlantelName] : [];
}

export function isAdminTeacherRole(role: UserRole | null | undefined): boolean {
  return role === "adminTeacher" || role === "superAdminTeacher";
}

export function isCampusCoordinatorRole(role: UserRole | null | undefined): boolean {
  return role === "coordinadorPlantel";
}

export function isDirectorRole(role: UserRole | null | undefined): boolean {
  return role === "director";
}

export function hasUserExtraRole(
  extraRoles: UserExtraRole[] | null | undefined,
  role: UserExtraRole,
): boolean {
  if (!extraRoles || extraRoles.length === 0) return false;
  return extraRoles.includes(role);
}

export async function resolveUserRoleAccessProfile(
  user: User,
): Promise<UserRoleAccessProfile> {
  let roleFromToken: UserRole | null = null;
  let extraRolesFromToken: UserExtraRole[] = [];

  try {
    const tokenResult = await user.getIdTokenResult();
    const claimRole = tokenResult.claims?.role;
    if (allowedRoles.includes(claimRole as UserRole)) {
      roleFromToken = claimRole as UserRole;
    }
    extraRolesFromToken = normalizeExtraRoles(tokenResult.claims?.extraRoles);
  } catch {
    // fall through to Firestore lookup
  }

  let roleFromDoc: UserRole | null = null;
  let extraRolesFromDoc: UserExtraRole[] = [];
  let plantelIds: string[] = [];
  let plantelNames: string[] = [];

  try {
    const userRef = doc(db, "users", user.uid);
    const snap = await getDoc(userRef);
    const data = (snap.data() ?? {}) as Record<string, unknown>;
    const role = data.role as UserRole | undefined;
    if (role && allowedRoles.includes(role)) {
      roleFromDoc = role;
    }
    extraRolesFromDoc = normalizeExtraRoles(data.extraRoles);
    if (data.directorEnabled === true) {
      extraRolesFromDoc = mergeExtraRoles(extraRolesFromDoc, ["director"]);
    }
    plantelIds = getPlantelIdsFromData(data);
    plantelNames = getPlantelNamesFromData(data);
  } catch {
    // ignore and return fallback values
  }

  return {
    role: roleFromToken ?? roleFromDoc,
    extraRoles: mergeExtraRoles(extraRolesFromDoc, extraRolesFromToken),
    plantelIds,
    plantelNames,
  };
}

export async function resolveUserRole(user: User): Promise<UserRole | null> {
  const accessProfile = await resolveUserRoleAccessProfile(user);
  return accessProfile.role;
}
