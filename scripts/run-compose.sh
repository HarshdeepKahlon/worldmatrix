#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

mkdir -p wmx_data/source wmx_data/wmx

echo "[worldmatrix] Starting docker compose..."
echo "[worldmatrix] Data dir: $ROOT_DIR/wmx_data"
echo "[worldmatrix] Source:   $ROOT_DIR/wmx_data/source"
echo "[worldmatrix] Output:   $ROOT_DIR/wmx_data/wmx"

docker compose up --build

