import { z } from "zod";
import { Invalid } from "./errors";

/** Parse input with a zod schema or throw an Invalid error with a readable message. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue.path.join(".");
    throw new Invalid(field ? `${field}: ${issue.message}` : issue.message);
  }
  return result.data;
}

export const id = z.uuid();
export const optionalId = z.uuid().nullable().optional();
/** YYYY-MM-DD */
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date (YYYY-MM-DD)");
