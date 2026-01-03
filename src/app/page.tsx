import { LoginCard } from "@/components/auth/LoginCard";

export default function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 px-4 py-10">
      <div className="w-full max-w-5xl">
        <div className="flex justify-center">
          <LoginCard />
        </div>
      </div>
    </main>
  );
}
