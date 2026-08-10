import { LoginCard } from "@/components/auth/LoginCard";

type LoginPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const redirectTo =
    typeof params?.redirectTo === "string" && params.redirectTo.startsWith("/")
      ? params.redirectTo
      : undefined;

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-10 text-slate-50">
      <LoginCard redirectTo={redirectTo} />
    </main>
  );
}
