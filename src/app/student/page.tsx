import { Suspense } from "react";
import StudentFeedPageClient from "./StudentFeedPageClient";

export default function StudentPage() {
  return (
    <Suspense fallback={null}>
      <StudentFeedPageClient />
    </Suspense>
  );
}
