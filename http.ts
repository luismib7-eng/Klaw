/**
 * Utilidades HTTP para funciones web de Vercel (Request/Response estándar):
 * errores tipados, respuestas JSON y CORS restringido a los orígenes permitidos.
 */
import { envOr } from "./env.js";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

function allowedOrigins(): string[] {
  return envOr("ALLOWED_ORIGINS", "https://luismib7-eng.github.io")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

export function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin || !allowedOrigins().includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function preflight(request: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export function json(request: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(request) },
  });
}

/** Convierte cualquier error en una respuesta JSON; los errores internos no exponen detalles. */
export function errorResponse(request: Request, error: unknown): Response {
  if (error instanceof HttpError) {
    return json(request, { error: { code: error.code, message: error.message, details: error.details } }, error.status);
  }
  console.error("[klaw] error interno", error);
  return json(request, { error: { code: "INTERNAL", message: "Error interno del servidor." } }, 500);
}
