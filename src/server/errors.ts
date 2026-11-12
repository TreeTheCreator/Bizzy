/** Errors the service layer throws. Entry points (web, API, MCP) translate them. */

export type ErrorCode =
  | "unauthenticated"
  | "permission_denied"
  | "reauth_required"
  | "not_found"
  | "invalid"
  | "internal";

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class PermissionDenied extends AppError {
  constructor(message = "You don't have permission to do that.") {
    super("permission_denied", message);
  }
}

export class ReauthRequired extends AppError {
  constructor() {
    super("reauth_required", "Please confirm your password to continue.");
  }
}

export class NotFound extends AppError {
  constructor(what = "Item") {
    super("not_found", `${what} not found.`);
  }
}

export class Invalid extends AppError {
  constructor(message: string) {
    super("invalid", message);
  }
}

interface DbError {
  code?: string;
  message: string;
}

/** Map a PostgREST / Postgres error to a service error. Never leaks SQL text for unknown errors. */
export function fromDbError(error: DbError): AppError {
  switch (error.code) {
    case "42501": // insufficient_privilege, incl. RLS violations
      return new PermissionDenied();
    case "P0403":
      return new ReauthRequired();
    case "28000":
      return new AppError("unauthenticated", "Please sign in.");
    case "P0001": // raise exception from our own functions: message is user-safe
    case "22023":
      return new Invalid(error.message);
    case "23505":
      return new Invalid("That already exists.");
    case "23503":
      return new Invalid("That refers to something that doesn't exist in this workspace.");
    case "23514":
    case "22P02":
      return new Invalid("That value isn't allowed.");
    default:
      console.error("[db]", error.code, error.message);
      return new AppError("internal", "Something went wrong.");
  }
}

/** Unwrap a Supabase result or throw the mapped error. */
export function unwrap<T>(result: { data: T | null; error: DbError | null }): T {
  if (result.error) throw fromDbError(result.error);
  return result.data as T;
}
