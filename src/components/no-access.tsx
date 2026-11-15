/** Shown when the caller's role does not include the page they opened. */
export function NoAccess({ what = "this page" }: { what?: string }) {
  return (
    <div className="card max-w-lg">
      <h1 className="h1 mb-2">You can&apos;t open this page</h1>
      <p className="muted">Your role doesn&apos;t include {what}. If you need it, ask the workspace owner.</p>
    </div>
  );
}
