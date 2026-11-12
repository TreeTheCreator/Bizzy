/** Shown when the caller's role does not include the page they opened. */
export function NoAccess({ what = "this page" }: { what?: string }) {
  return (
    <div className="card max-w-lg">
      <h1 className="h1 mb-2">No access</h1>
      <p className="muted">Your role doesn&apos;t include {what}. Ask the workspace owner if you need it.</p>
    </div>
  );
}
