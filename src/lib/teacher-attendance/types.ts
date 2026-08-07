import type { TeacherAccessRole } from "@/lib/server/require-teacher-access";

export type TeacherAttendanceLocation = {
  latitude: number;
  longitude: number;
  accuracy: number | null;
};

export type TeacherFaceVerification = {
  status: "verified" | "rejected";
  provider: string;
  confidence: number | null;
  checkedAt: string;
  reason: string | null;
};

export type TeacherAttendanceRecord = {
  id: string;
  teacherId: string;
  teacherName: string;
  teacherEmail: string | null;
  teacherRole: TeacherAccessRole;
  status: "open" | "closed";
  checkInAt: string;
  checkOutAt: string | null;
  checkInLocation: TeacherAttendanceLocation;
  checkOutLocation: TeacherAttendanceLocation | null;
  faceVerification: TeacherFaceVerification;
  createdAt: string | null;
  updatedAt: string | null;
};

export type TeacherAttendanceApiPayload = {
  activeRecord: TeacherAttendanceRecord | null;
  recentRecords: TeacherAttendanceRecord[];
};
