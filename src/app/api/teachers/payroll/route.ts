import { NextRequest, NextResponse } from "next/server";
import { getAdminFirestore } from "@/lib/firebase/admin";
import {
  requireTeacherAccess,
  TeacherAccessError,
  toTeacherAccessErrorResponse,
  type TeacherAccessContext,
} from "@/lib/server/require-teacher-access";
import {
  normalizeTeacherPayrollDeposit,
  normalizeTeacherProfessionalProfile,
} from "@/lib/teachers/profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PlantelAssignment = {
  plantelId: string;
  plantelName: string;
};

function canManageTeacherPayroll(role: TeacherAccessContext["role"]): boolean {
  return (
    role === "adminTeacher" ||
    role === "superAdminTeacher" ||
    role === "coordinadorPlantel" ||
    role === "director"
  );
}

function asPositiveLimit(value: string | null): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 200;
  return Math.min(Math.trunc(parsed), 500);
}

function asUniqueStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean),
    ),
  );
}

function getPlantelIdsFromData(data: Record<string, unknown> | undefined): string[] {
  if (!data) return [];
  const explicit = asUniqueStringArray(data.plantelIds);
  if (explicit.length > 0) return explicit;
  const legacyPlantelId = asText(data.plantelId);
  return legacyPlantelId ? [legacyPlantelId] : [];
}

function hasPlantelIntersection(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) return false;
  const rightSet = new Set(right);
  return left.some((plantelId) => rightSet.has(plantelId));
}

function dedupePlantelAssignments(assignments: PlantelAssignment[]): PlantelAssignment[] {
  const map = new Map<string, PlantelAssignment>();
  assignments.forEach((assignment) => {
    if (!assignment.plantelId) return;
    const existing = map.get(assignment.plantelId);
    if (!existing || (!existing.plantelName && assignment.plantelName)) {
      map.set(assignment.plantelId, assignment);
    }
  });
  return Array.from(map.values());
}

function getPlantelAssignmentsFromUserData(
  data: Record<string, unknown> | undefined,
): PlantelAssignment[] {
  if (!data) return [];
  const plantelIds = getPlantelIdsFromData(data);
  const plantelNames = asUniqueStringArray(data.plantelNames);
  if (plantelIds.length > 0) {
    return dedupePlantelAssignments(
      plantelIds.map((plantelId, index) => ({
        plantelId,
        plantelName: plantelNames[index] ?? "",
      })),
    );
  }
  return [];
}

function addTeacherPlantelAssignment(
  map: Map<string, PlantelAssignment[]>,
  teacherId: string,
  assignment: PlantelAssignment,
): void {
  if (!teacherId || !assignment.plantelId) return;
  map.set(
    teacherId,
    dedupePlantelAssignments([...(map.get(teacherId) ?? []), assignment]),
  );
}

async function getTeacherPlantelAssignmentsFromGroups(
  firestore: ReturnType<typeof getAdminFirestore>,
  plantelIds: string[],
): Promise<Map<string, PlantelAssignment[]>> {
  const map = new Map<string, PlantelAssignment[]>();
  await Promise.all(
    plantelIds.map(async (plantelId) => {
      const snap = await firestore
        .collection("groups")
        .where("plantelId", "==", plantelId)
        .get();

      snap.docs.forEach((docSnap) => {
        const groupData = docSnap.data() as Record<string, unknown>;
        const assignment = {
          plantelId,
          plantelName: asText(groupData.plantelName),
        };
        addTeacherPlantelAssignment(map, asText(groupData.teacherId), assignment);
        asUniqueStringArray(groupData.assistantTeacherIds).forEach((mentorId) => {
          addTeacherPlantelAssignment(map, mentorId, assignment);
        });
      });
    }),
  );
  return map;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function getMillis(value: unknown): number {
  if (value && typeof value === "object" && "toMillis" in value) {
    const toMillis = (value as { toMillis?: unknown }).toMillis;
    if (typeof toMillis === "function") {
      const millis = toMillis.call(value);
      return Number.isFinite(millis) ? millis : 0;
    }
  }
  return 0;
}

export async function GET(request: NextRequest) {
  try {
    const requester = await requireTeacherAccess(request);
    if (!canManageTeacherPayroll(requester.role)) {
      throw new TeacherAccessError(
        403,
        "Acceso restringido a administradores, directores y coordinadores",
      );
    }

    const limit = asPositiveLimit(request.nextUrl.searchParams.get("limit"));
    const firestore = getAdminFirestore();
    const requesterUserSnap = await firestore.collection("users").doc(requester.uid).get();
    const requesterPlantelIds = getPlantelIdsFromData(
      requesterUserSnap.data() as Record<string, unknown> | undefined,
    );
    const shouldFilterByPlantel =
      requester.role === "coordinadorPlantel" || requester.role === "director";

    if (shouldFilterByPlantel && requesterPlantelIds.length === 0) {
      return NextResponse.json({ success: true, teachers: [] });
    }

    const groupPlantelAssignmentsByTeacherId = shouldFilterByPlantel
      ? await getTeacherPlantelAssignmentsFromGroups(firestore, requesterPlantelIds)
      : new Map<string, PlantelAssignment[]>();

    const snap = await firestore
      .collection("users")
      .where("role", "==", "teacher")
      .get();

    const teachers = snap.docs
      .map((docSnap) => {
        const data = docSnap.data() as Record<string, unknown>;
        const plantelAssignments = dedupePlantelAssignments([
          ...getPlantelAssignmentsFromUserData(data),
          ...(groupPlantelAssignmentsByTeacherId.get(docSnap.id) ?? []),
        ]);
        const plantelIds = plantelAssignments.map((assignment) => assignment.plantelId);
        const plantelNames = plantelAssignments.map((assignment) => assignment.plantelName);
        const primaryPlantel = plantelAssignments[0] ?? null;
        return {
          teacher: {
            id: docSnap.id,
            name: asText(data.displayName) || asText(data.name) || "Profesor",
            email: asText(data.email),
            role: "teacher" as const,
            extraRoles: [],
            phone: asText(data.phone) || null,
            plantelIds,
            plantelNames,
            plantelId: primaryPlantel?.plantelId ?? null,
            plantelName: primaryPlantel?.plantelName ?? null,
            teacherProfile: normalizeTeacherProfessionalProfile(data.teacherProfile),
            payrollDeposit: normalizeTeacherPayrollDeposit(data.payrollDeposit),
          },
          createdAtMillis: getMillis(data.createdAt),
        };
      })
      .filter(
        (item) =>
          !shouldFilterByPlantel ||
          hasPlantelIntersection(requesterPlantelIds, item.teacher.plantelIds),
      )
      .sort((a, b) => b.createdAtMillis - a.createdAtMillis)
      .slice(0, limit)
      .map((item) => item.teacher);

    return NextResponse.json({ success: true, teachers });
  } catch (error) {
    return toTeacherAccessErrorResponse(error, "Error cargando datos de nómina docente");
  }
}
