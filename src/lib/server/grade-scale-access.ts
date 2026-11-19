import type { NextRequest } from "next/server";
import { getAdminFirestore } from "@/lib/firebase/admin";
import { requireTeacherAccess, TeacherAccessError } from "@/lib/server/require-teacher-access";

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";

export function gradeScalePolicy(role: string, data: Record<string, unknown>) {
  const globalAccess = role === "adminTeacher" || role === "superAdminTeacher";
  const extraRoles = data.extraRoles;
  const director = role === "director" || (role === "coordinadorPlantel" &&
    (data.directorEnabled === true || (Array.isArray(extraRoles) ? extraRoles.includes("director")
      : !!extraRoles && typeof extraRoles === "object" && (extraRoles as Record<string, unknown>).director === true)));
  if (!globalAccess && !director) throw new TeacherAccessError(403, "Acceso restringido a administradores y directores.");
  const plantelIds = Array.isArray(data.plantelIds) ? data.plantelIds.map(text).filter(Boolean) : [];
  if (!plantelIds.length && text(data.plantelId)) plantelIds.push(text(data.plantelId));
  return { globalAccess, plantelIds: [...new Set(plantelIds)] };
}

export function canReviewGradeGroup(policy: ReturnType<typeof gradeScalePolicy>, uid: string, group: Record<string, unknown>) {
  return policy.globalAccess || policy.plantelIds.includes(text(group.plantelId)) ||
    (group.isInPerson !== true && text(group.coordinatorId) === uid);
}

export async function requireGradeScaleAccess(request: NextRequest) {
  const actor = await requireTeacherAccess(request);
  const db = getAdminFirestore();
  if (actor.role === "adminTeacher" || actor.role === "superAdminTeacher") return { actor, allowedGroupIds: null };
  const userData = (await db.collection("users").doc(actor.uid).get()).data() || {};
  const policy = gradeScalePolicy(actor.role, userData);
  const [campusGroups, assignedGroups] = await Promise.all([
    Promise.all(policy.plantelIds.map(plantelId => db.collection("groups").where("plantelId", "==", plantelId).get())),
    db.collection("groups").where("coordinatorId", "==", actor.uid).get(),
  ]);
  return { actor, allowedGroupIds: [...new Set([
    ...campusGroups.flatMap(snapshot => snapshot.docs.map(doc => doc.id)),
    ...assignedGroups.docs.filter(doc => doc.data().isInPerson !== true).map(doc => doc.id),
  ])].sort() };
}
