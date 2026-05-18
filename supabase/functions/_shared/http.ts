import { corsHeaders } from './cors.ts';

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export function errorResponse(message: string, status = 400, extra?: unknown): Response {
  return jsonResponse({ error: message, details: extra }, status);
}

export async function parseJsonBody<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw errorResponse('invalid_json', 400);
  }
}
