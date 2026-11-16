export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-10">
      <p className="mb-1 text-3xl font-semibold">Bizzy</p>
      <p className="muted mb-6">Run your business from one place.</p>
      {children}
    </main>
  );
}
