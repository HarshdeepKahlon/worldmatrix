# WMX Streaming Spec v1

Canonical location: `manifest.streaming` in `asset.wmx.json`.

Schema id: `wmx-streaming-refine-tree@1`

## Top-level shape

```json
{
  "schemaVersion": "1.0",
  "assetId": "example",
  "variants": { "low": {}, "medium": {}, "high": {} },
  "streaming": {
    "schema": "wmx-streaming-refine-tree@1",
    "rootTileId": "root",
    "tiles": {
      "root": {
        "id": "root",
        "children": ["n0"],
        "refine": "replace",
        "bounds": {
          "sphere": { "center": [0, 0, 0], "radius": 10 },
          "aabb": { "min": [-1, -1, -1], "max": [1, 1, 1] }
        },
        "content": {
          "ultraLow": { "url": "tiles/root/ultraLow.glb" },
          "low": { "url": "tiles/root/low.glb" },
          "medium": { "url": "tiles/root/medium.glb" },
          "high": { "url": "tiles/root/high.glb" }
        }
      }
    }
  }
}
```

## Tile fields

- `id` (required): unique tile id.
- `parentId` (optional): parent tile id.
- `children` (required): array of child tile ids.
- `refine` (optional): `replace` (default) or `add`.
- `transform` (optional): TRS transform relative to parent.
- `bounds` (required):
  - `sphere` is required and used for baseline frustum/SSE decisions.
  - `aabb` is optional but recommended for tighter runtime probes/debugging.
- `geometricError` (optional): future SSE policy input.
- `content` (optional): quality -> WMX variant payload; omitted means structural tile.

## URL resolution

- Tile `content.*.url` values may be relative.
- Runtimes resolve relative URLs against the manifest URL.

## Runtime compatibility notes

- Current readers accept legacy `manifest.extras.streaming` as fallback.
- Producers should write **only** `manifest.streaming` going forward.

## Recommended producer behavior

- Stage 2 outputs should place tile payloads at:
  - `tiles/<tileId>/<quality>.glb`
- Include variant metadata when available:
  - `bytes`, `metrics`, `requires`

## Validation expectations

A valid v1 streaming block must have:

- `schema === "wmx-streaming-refine-tree@1"`
- non-empty `rootTileId`
- `tiles[rootTileId]` exists
