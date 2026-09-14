# count-inventory

Prototipo: conteo e identificación de productos a partir de una foto de anaquel/góndola de tienda.

## Contexto

Herramienta de shelf/planogram analytics: sube una foto de una góndola y el sistema identifica cada unidad de producto visible (categoría, marca cuando el texto es legible, variante) y las cuenta.

## Arquitectura (2 etapas)

**Etapa 1 — localización + conteo (implementada aquí).** Un modelo de visión (Claude) recibe la foto —dividida en columnas para no subcontar en góndolas densas— y devuelve, por cada unidad visible, categoría, una lectura de marca/variante si el empaque es legible, y nivel de confianza.

**Etapa 2 — identificación exacta de SKU (pendiente, requiere insumo).** Para reconocimiento exacto de marca/tamaño (no solo lo que el texto del empaque permite leer), cada detección de la etapa 1 debe compararse por embeddings de imagen contra un catálogo de fotos de referencia de los productos reales del cliente (Rekognition Custom Labels, o embeddings + similaridad coseno en OpenSearch/pgvector). Sin ese catálogo, "SKU exacto" no es alcanzable solo con la foto de la góndola, sin importar el modelo usado.

## Contenido

- **`shelf_counter.py`** — script de línea de comandos, etapa 1. Divide la foto en columnas, llama a la API de Anthropic (Claude con visión) por cada columna, y agrega los resultados en un reporte JSON (unidades totales, por categoría, por marca identificada).

  ```bash
  pip install anthropic pillow
  export ANTHROPIC_API_KEY=...
  python3 shelf_counter.py foto_gondola.jpg --tiles 3
  ```

  Para producción sobre AWS, reemplazar la llamada a la API de Anthropic por Bedrock (`bedrock-runtime invoke_model`) dentro de `call_vision_model()` — el prompt y el schema de salida no cambian.

- **`web/index.html`** — interfaz de subir-foto-y-analizar. Detecta en qué contexto corre:
  - Dentro de un artifact de Claude: usa `window.claude.use("sample")` (uso de IA del propio usuario, sin backend).
  - Fuera de Claude (ej. desplegada en un sitio propio): usa `POST /api/analyze` como respaldo.

- **`functions/api/analyze.js`** — función de backend para **Cloudflare Pages**. Recibe `{image, mediaType, prompt}` en JSON, llama a la API de Anthropic con una API key del servidor, y le devuelve el JSON a `web/index.html`. Necesaria porque `window.claude` no existe fuera del visor de artifacts de Claude.
- **`netlify/functions/analyze.mjs`** — la misma función, escrita para **Netlify Functions**. Misma lógica, misma ruta pública (`/api/analyze`, vía `config.path`), pero con el aviso de timeout de la siguiente sección.
- **`netlify.toml`** — fija el Publish directory (`web`) en el repo, para que no dependa de la configuración manual del dashboard.

## Despliegue en Cloudflare Pages (recomendado)

Por qué Cloudflare y no Netlify/Vercel: una llamada de Claude con visión tarda 5–60s, y en Cloudflare Workers el tiempo de espera de un `fetch()` a una API externa **no cuenta** contra el límite de CPU del plan gratis (10ms) — solo se mide cómputo real. Netlify/Vercel cortan funciones síncronas a los 10s en su plan gratis, sin importar en qué se fue el tiempo.

1. `dash.cloudflare.com` → **Workers & Pages** → **Create** → **Pages** → **Connect to Git** → selecciona este repo.
2. Build settings:
   - **Framework preset:** None
   - **Build command:** (vacío)
   - **Build output directory:** `web`
3. **Settings → Environment variables** (en Production y Preview):
   - `ANTHROPIC_API_KEY` — marcar como **Secret**
   - `CLAUDE_MODEL` (opcional) — si no se define, usa el default en `analyze.js`
   - `ANALYZE_TOKEN` (opcional) — traba simple contra abuso; si la defines aquí, pon el mismo valor en `BACKEND_TOKEN` dentro de `web/index.html` antes de desplegar (esto NO es autenticación real, cualquiera que vea el código fuente lo ve — para algo serio, usar Cloudflare Access)
4. Deploy. `functions/` se despliega automático junto con `web/` — no hace falta configurarlo aparte.

## Despliegue en Netlify (alternativa — con una limitación real)

1. En el dashboard del sitio: **Project configuration → Build & deploy → Publish directory** → `web` (o simplemente deja que `netlify.toml` lo haga, ya viene en el repo).
2. **Project configuration → Environment variables → Add a variable**:
   - `ANTHROPIC_API_KEY` — tu key de `console.anthropic.com` (API Keys → Create Key)
   - `CLAUDE_MODEL` (opcional)
   - `ANALYZE_TOKEN` (opcional, mismo aviso que arriba)
3. Vuelve a desplegar (**Deploys → ⋯ → Retry deployment**, o un `git push` nuevo) — las variables de entorno solo aplican a despliegues hechos después de configurarlas.
4. `netlify/functions/analyze.mjs` se detecta y publica solo, en `/api/analyze` (por el `config.path` del archivo) — no hace falta ninguna regla de redirect.

**Limitación a tener presente:** las funciones síncronas de Netlify se cortan a los 10 segundos en el plan gratis, y una sola llamada de Claude con visión típicamente tarda más que eso. Es probable que el análisis falle de forma intermitente — más seguido con fotos grandes o con 3-4 columnas. Si pasa: prueba con **1 sola columna** (llamada más simple y rápida), o considera Cloudflare Pages, que no tiene este límite.

## Estado

Prototipo para validar el enfoque antes de decidir arquitectura de producción (integración con RetailIQ/ALLEC, catálogo de referencia para SKU exacto, pipeline en AWS si aplica).
