#!/usr/bin/env bash
set -e

echo "========================================"
echo " VeloraGames Backend"
echo "========================================"

command -v node >/dev/null 2>&1 || {
  echo "ERROR: Node.js tidak tersedia."
  exit 1
}

echo "[1/3] Menyiapkan D1..."

node scripts/deploy.mjs

echo "[2/3] Deploy selesai."

echo "[3/3] Memasukkan schema D1..."

npx wrangler d1 execute velora --remote --file=./schema.sql

echo ""
echo "========================================"
echo " VELORA BACKEND BERHASIL"
echo "========================================"
