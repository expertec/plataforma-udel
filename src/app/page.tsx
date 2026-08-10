import { LoginCard } from "@/components/auth/LoginCard";

type HomeProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function Home({ searchParams }: HomeProps) {
  const params = await searchParams;
  const redirectTo =
    typeof params?.redirectTo === "string" && params.redirectTo.startsWith("/")
      ? params.redirectTo
      : undefined;

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 px-4 py-10">
      <div className="w-full max-w-5xl">
        <div className="flex justify-center">
          <LoginCard redirectTo={redirectTo} />
        </div>
      </div>
    </main>
  );
}
