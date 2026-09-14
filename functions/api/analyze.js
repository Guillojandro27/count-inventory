// Cloudflare Pages Function — POST /api/analyze
//
// Recibe una imagen (multipart/form-data) desde web/index.html, la manda a la
// API de Anthropic (Claude, con visión) y devuelve el JSON de items detectados
// tal cual lo espera el frontend: {"items": [...]}.
//
// Por qué esto vive en Cloudflare y no en Netlify: una llamada de Claude con
// visión puede tardar 5-60s. En Cloudflare Workers, el tiempo de espera de una
// solicitud fetch() a una API externa NO cuenta contra el límite de CPU del
// plan gratis (10ms) — solo se mide cómputo real. Netlify sí corta funciones
// síncronas a los 10s sin importar en qué se les fue el tiempo.
//
// Variables de entorno a configurar en Cloudflare (Pages → Settings →
// Environment variables):
//   ANTHROPIC_API_KEY  (obligatoria, marcar como "Secret")
//   CLAUDE_MODEL       (opcional; default abajo)
//   ANALYZE_TOKEN      (opcional; ver nota de seguridad más abajo)

const DEFAULT_MODEL = "claude-opus-4-5-20251101";

export async function onRequestPost(context) {
  const { request, env } = context;

  // --- Nota de seguridad ---
  // Este endpoint es público: cualquiera que descubra la URL puede llamarlo y
  // consumir tu cuota de la API de Anthropic. ANALYZE_TOKEN es una traba
  // simple (no reemplaza autenticación real): si la defines en el entorno,
  // el frontend debe mandar el mismo valor en el header X-Analyze-Token.
  if (env.ANALYZE_TOKEN) {
    const provided = request.headers.get("X-Analyze-Token");
    if (provided !== env.ANALYZE_TOKEN) {
      return json({ error: "unauthorized" }, 401);
    }
  }

  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: "server_misconfigured", message: "Falta ANTHROPIC_API_KEY en el entorno de Cloudflare." }, 500);
  }

  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return json({ error: "invalid_request", message: "Se esperaba multipart/form-data." }, 400);
  }

  const file = form.get("image");
  const prompt = form.get("prompt");
  if (!file || typeof file === "string") {
    return json({ error: "invalid_request", message: "Falta el campo 'image'." }, 400);
  }
  if (!prompt || typeof prompt !== "string") {
    return json({ error: "invalid_request", message: "Falta el campo 'prompt'." }, 400);
  }

  const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
  if (file.size > MAX_BYTES) {
    return json({ error: "image_too_large", message: "Máximo 10 MB por imagen." }, 400);
  }

  const mediaType = file.type || "image/jpeg";
  const buffer = await file.arrayBuffer();
  const base64 = arrayBufferToBase64(buffer);

  const model = env.CLAUDE_MODEL || DEFAULT_MODEL;

  let anthropicResp;
  try {
    anthropicResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
              { type: "text", text: prompt },
            ],
          },
        ],
      }),
    });
  } catch (e) {
    return json({ error: "upstream_error", message: "No se pudo contactar a la API de Anthropic." }, 502);
  }

  if (!anthropicResp.ok) {
    const errBody = await anthropicResp.text().catch(() => "");
    return json({ error: "upstream_error", message: `Anthropic respondió ${anthropicResp.status}`, detail: errBody.slice(0, 500) }, 502);
  }

  const data = await anthropicResp.json();
  const text = (data.content && data.content[0] && data.content[0].text) || "";
  const parsed = extractJson(text);
  if (!parsed) {
    return json({ error: "invalid_json", message: "La respuesta del modelo no tenía JSON válido.", raw: text.slice(0, 1000) }, 502);
  }

  return json(parsed, 200);
}

// Cualquier otro método -> 405
export async function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return json({ error: "method_not_allowed" }, 405);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function extractJson(text) {
  var t = text.trim();
  if (t.startsWith("```")) {
    var body = t.split("```")[1] || "";
    t = body.startsWith("json") ? body.slice(4) : body;
    t = t.trim();
  }
  try {
    return JSON.parse(t);
  } catch (e) {
    var start = Math.min(...["{", "["].map((c) => { var i = t.indexOf(c); return i === -1 ? Infinity : i; }));
    var endChar = t[start] === "{" ? "}" : "]";
    var end = t.lastIndexOf(endChar);
    if (start === Infinity || end === -1) return null;
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch (e2) {
      return null;
    }
  }
}
