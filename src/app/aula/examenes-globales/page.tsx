import StudentGlobalExamsPage from "@/app/student/examenes-globales/page";

export default function AulaGlobalExamsPage() {
  return (
    <StudentGlobalExamsPage
      backHref="/aula"
      backLabel="Volver al aula"
      profileHref="/aula/perfil"
      profileLabel="Ir a mi perfil"
    />
  );
}
