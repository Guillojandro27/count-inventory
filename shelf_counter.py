"""
shelf_counter.py — Prototipo: conteo e identificacion de productos en fotos de gondola.

ARQUITECTURA (2 etapas)
------------------------
Etapa 1 (este script, funcional hoy): un modelo de vision (Claude) localiza cada
"facing" de producto en la foto y devuelve categoria + una lectura del texto/marca
visible en el empaque, con nivel de confianza. Para gondolas densas, la foto se
divide en tiles (columnas) antes de mandarla al modelo — mandar la foto completa
de una vez subestima el conteo porque el modelo "se pierde" en zonas muy pobladas.

Etapa 2 (placeholder aqui, pendiente de catalogo): para identificacion EXACTA de
SKU (no solo marca visible), cada deteccion de la etapa 1 se debe comparar via
embeddings de imagen contra un catalogo de fotos de referencia de los productos
reales que maneja el cliente (Rekognition Custom Labels, o embeddings CLIP +
similaridad coseno en OpenSearch/pgvector). Sin ese catalogo, el texto que el
modelo alcanza a leer en el empaque es la unica fuente de "marca", y no siempre
alcanza a distinguir variantes (ej. mismo producto en dos tamanos).

USO
---
    pip install anthropic pillow --break-system-packages
    export ANTHROPIC_API_KEY=...
    python3 shelf_counter.py foto_gondola.jpg --tiles 3

Para correrlo contra Bedrock en vez de la API directa de Anthropic, ver la
funcion call_vision_model() — el cambio es solo el cliente que hace la llamada,
el prompt y el schema de salida no cambian.
"""

import argparse
import base64
import json
import os
from collections import defaultdict
from pathlib import Path

from PIL import Image

DETECTION_PROMPT = """Estas viendo una foto (o un recorte) de un anaquel/gondola de tienda.

Tu tarea: listar CADA unidad de producto individual visible (cada "facing"),
no solo los tipos de producto. Cuenta unidades repetidas del mismo producto
como entradas separadas.

Para cada unidad visible, reporta:
- "category": categoria general (ej. "shampoo", "desodorante", "pasta dental",
  "papel higienico", "toallas humedas")
- "brand_guess": marca o nombre de producto SI el texto en el empaque es
  legible con confianza razonable; si no es legible, usa null
- "variant_guess": tamano/variante si es legible (ej. "400ml"), si no null
- "confidence": "high" | "medium" | "low" — que tan seguro estas de la
  identificacion de marca/variante (el conteo de unidades puede ser high
  aunque la marca sea low)
- "color_pattern": color/patron dominante del empaque, para poder agrupar
  visualmente aunque no se pueda leer el texto

Devuelve SOLO un JSON con esta forma, sin texto adicional:
{"items": [{"category": "...", "brand_guess": "...", "variant_guess": "...",
"confidence": "...", "color_pattern": "..."}]}
"""


def call_vision_model(image_b64: str, media_type: str) -> dict:
    """Etapa 1: manda un recorte de la foto a Claude y devuelve la lista de items detectados.

    Usa la API directa de Anthropic. Para produccion sobre AWS, reemplazar el
    cuerpo de esta funcion por una llamada a bedrock-runtime invoke_model con
    el modelo Claude en Bedrock — el prompt (DETECTION_PROMPT) y el schema de
    salida se mantienen igual.
    """
    import anthropic

    client = anthropic.Anthropic()  # usa ANTHROPIC_API_KEY del entorno
    resp = client.messages.create(
        model="claude-opus-4-5-20251101",
        max_tokens=4096,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": image_b64,
                        },
                    },
                    {"type": "text", "text": DETECTION_PROMPT},
                ],
            }
        ],
    )
    text = resp.content[0].text.strip()
    # el modelo a veces envuelve el JSON en ```json ... ``` pese a la instruccion
    if text.startswith("```"):
        text = text.split("```")[1]
        text = text[4:] if text.startswith("json") else text
    return json.loads(text)


def tile_image(image_path: Path, n_tiles: int):
    """Divide la foto en n_tiles columnas verticales para mejorar el conteo
    en gondolas densas (mandar la foto completa de un solo golpe subestima)."""
    img = Image.open(image_path).convert("RGB")
    w, h = img.size
    tile_w = w // n_tiles
    tiles = []
    for i in range(n_tiles):
        left = i * tile_w
        right = w if i == n_tiles - 1 else (i + 1) * tile_w
        tiles.append(img.crop((left, 0, right, h)))
    return tiles


def image_to_b64(img: Image.Image) -> str:
    import io

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def aggregate(all_items: list[dict]) -> dict:
    by_category = defaultdict(int)
    by_brand = defaultdict(int)
    unidentified = 0
    for item in all_items:
        by_category[item.get("category", "desconocido")] += 1
        brand = item.get("brand_guess")
        if brand:
            by_brand[f"{brand} {item.get('variant_guess') or ''}".strip()] += 1
        else:
            unidentified += 1
    return {
        "total_unidades": len(all_items),
        "por_categoria": dict(sorted(by_category.items(), key=lambda x: -x[1])),
        "por_marca_identificada": dict(sorted(by_brand.items(), key=lambda x: -x[1])),
        "unidades_sin_marca_legible": unidentified,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path, help="Foto de la gondola")
    parser.add_argument(
        "--tiles", type=int, default=3, help="Columnas para dividir la foto (default 3)"
    )
    parser.add_argument("--out", type=Path, default=Path("resultado.json"))
    args = parser.parse_args()

    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise SystemExit("Falta ANTHROPIC_API_KEY en el entorno.")

    tiles = tile_image(args.image, args.tiles)
    all_items = []
    for idx, tile in enumerate(tiles):
        b64 = image_to_b64(tile)
        result = call_vision_model(b64, "image/jpeg")
        items = result.get("items", [])
        print(f"Tile {idx + 1}/{len(tiles)}: {len(items)} unidades detectadas")
        all_items.extend(items)

    report = aggregate(all_items)
    args.out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

    print("\n--- Reporte ---")
    print(json.dumps(report, indent=2, ensure_ascii=False))
    print(f"\nGuardado en {args.out}")


if __name__ == "__main__":
    main()
