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

- **`web/index.html`** — interfaz de subir-foto-y-analizar, publicada como Claude Artifact. Corre la etapa 1 directamente en el navegador (usa el uso de IA del propio usuario vía `window.claude.use("sample")`, sin backend ni API key), con el mismo enfoque de dividir la foto en columnas para góndolas densas.

## Estado

Prototipo para validar el enfoque antes de decidir arquitectura de producción (integración con RetailIQ/ALLEC, catálogo de referencia para SKU exacto, pipeline en AWS).
