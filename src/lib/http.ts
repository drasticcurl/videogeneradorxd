/**
 * Helpers compartidos para los route handlers.
 */
import { NextResponse } from "next/server";

export function ok(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export function badRequest(message: string, extra?: unknown) {
  return NextResponse.json({ error: message, detail: extra }, { status: 400 });
}

export function notFound(message = "No encontrado") {
  return NextResponse.json({ error: message }, { status: 404 });
}

export function serverError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return NextResponse.json({ error: message }, { status: 500 });
}
