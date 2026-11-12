export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center px-4 py-10">
      <p className="mb-6 text-2xl font-semibold">Bizzy</p>
      {children}
    </main>
  );
}
