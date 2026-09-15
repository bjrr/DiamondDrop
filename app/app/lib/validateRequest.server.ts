import type { ZodSchema } from "zod";

/**
 * Shared server-side input validation helper for every route boundary
 * (spec §0.2). Client-side validation is never sufficient on its own.
 */
export class RequestValidationError extends Error {
  constructor(public readonly issues: { path: string; message: string }[]) {
    super("Request validation failed");
    this.name = "RequestValidationError";
  }
}

export function parseWithSchema<T>(schema: ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new RequestValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path.join(".") || "(root)",
        message: issue.message,
      }))
    );
  }
  return result.data;
}

export async function parseJsonBody<T>(request: Request, schema: ZodSchema<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new RequestValidationError([{ path: "(body)", message: "Request body is not valid JSON" }]);
  }
  return parseWithSchema(schema, raw);
}

export function parseSearchParams<T>(schema: ZodSchema<T>, searchParams: URLSearchParams): T {
  return parseWithSchema(schema, Object.fromEntries(searchParams.entries()));
}
