import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-3xl font-bold">Beach not found</h1>
      <p className="text-slate-400">
        We don&apos;t have conditions for that spot yet.
      </p>
      <Link href="/" className="text-ocean-400 hover:underline">
        ← Back to all beaches
      </Link>
    </main>
  );
}
