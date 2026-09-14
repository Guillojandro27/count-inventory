// Netlify Function (moderna, Request/Response) — POST /api/analyze
//
// Misma lógica que functions/api/analyze.js (la versión para Cloudflare
// Pages) — recibe {image, mediaType, prompt} en JSON, llama a la API de
// Anthropic con la API key del servidor, y devuelve {"items": [...]}.
//
// AVISO IMPORTANTE: las funciones síncronas de Netlify se cortan a los 10
// segundos en el plan gratis. Una sola llamada de Claude con visión suele
// tardar 5-60s — esta función puede fallar de forma intermitente,
// especialmente con fotos grandes o varias columnas. Si te pasa seguido,
// las opciones son: (a) usar 1 sola columna para que la llamada sea más
// rápida, (b) subir a un plan de Netlify con Background Functions (hasta 15
// min), o (c) desplegar en Cloudflare Pages en su lugar (ver
// functions/api/analyze.js y el README) — ahí no aplica este límite.
//
// Variables de entorno a configurar en Netlify (Site configuration →
// Environment variables):
//   ANTHROPIC_API_KEY  (obligatoria)
//   CLAUDE_MODEL       (opcional; default abajo)
//   ANALYZE_TOKEN      (opcional; ver nota de seguridad más abajo)

const DEFAULT_MODEL = "claude-opus-4-5-20251101";

export default async (req, context) => {
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  // --- Nota de seguridad ---
  // Este endpoint es público: cualquiera que descubra la URL puede llamarlo
  // y consumir tu cuota de la API de Anthropic. ANALYZE_TOKEN es una traba
  // simple (no reemplaza autenticación real): si la defines, el frontend
  // debe mandar el mismo valor en el header X-Analyze-Token.
  if (process.env.ANALYZE_TOKEN) {
    const provided = req.headers.get("X-Analyze-Token");
    if (provided !== process.env.ANALYZE_TOKEN) {
      return json({ error: "unauthorized" }, 401);
    }
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return json({ error: "server_misconfigured", message: "Falta ANTHROPIC_API_KEY en las variables de entorno de Netlify." }, 500);
  }

  let payload;
  try {
    payload = await req.json();
  } catch (e) {
    return json({ error: "invalid_request", message: "Se esperaba un cuerpo JSON." }, 400);
  }

  const { image, mediaType, prompt } = payload || {};
  if (!image || typeof image !== "string") return json({ error: "invalid_request", message: "Falta el campo 'image' (base64)." }, 400);
  if (!prompt || typeof prompt !== "string") return json({ error: "invalid_request", message: "Falta el campo 'prompt'." }, 400);

  const MAX_BASE64_LEN = 14 * 1024 * 1024; // ~10 MB de imagen
  if (image.length > MAX_BASE64_LEN) return json({ error: "image_too_large", message: "Máximo ~10 MB por imagen." }, 400);

  const model = process.env.CLAUDE_MODEL || DEFAULT_MODEL;

  let resp;
  try {
    resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data: image } },
              { type: "text", text: prompt },
            ],
          },
        ],
      }),
    });
  } catch (e) {
    return json({ error: "upstream_error", message: "No se pudo contactar a la API de Anthropic." }, 502);
  }

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => "");
    return json({ error: "upstream_error", message: `Anthropic respondió ${resp.status}`, detail: errBody.slice(0, 500) }, 502);
  }

  const data = await resp.json();
  const text = (data.content && data.content[0] && data.content[0].text) || "";
  const parsed = extractJson(text);
  if (!parsed) return json({ error: "invalid_json", message: "La respuesta del modelo no tenía JSON válido.", raw: text.slice(0, 1000) }, 502);

  return json(parsed, 200);
};

export const config = { path: "/api/analyze" };

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

function extractJson(text) {
  let t = text.trim();
  if (t.startsWith("```")) {
    const body = t.split("```")[1] || "";
    t = (body.startsWith("json") ? body.slice(4) : body).trim();
  }
  try {
    return JSON.parse(t);
  } catch (e) {
    const start = Math.min(...["{", "["].map((c) => { const i = t.indexOf(c); return i === -1 ? Infinity : i; }));
    const endChar = t[start] === "{" ? "}" : "]";
    const end = t.lastIndexOf(endChar);
    if (start === Infinity || end === -1) return null;
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch (e2) {
      return null;
    }
  }
}
