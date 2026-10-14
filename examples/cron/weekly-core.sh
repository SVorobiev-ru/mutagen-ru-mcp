#!/usr/bin/env bash
# Еженедельная пересборка семантического ядра для cron.
#
# Ключ и настройки — в файле рядом со скриптом (chmod 600), например mutagen.env:
#   MUTAGEN_API_KEY=ваш_ключ
#   MUTAGEN_BUDGET_RUB=20
#
# Нужен CLI: npm install --global mutagen-ru-mcp

set -euo pipefail

dir="$(cd "$(dirname "$0")" && pwd)"
env_file="${MUTAGEN_ENV_FILE:-$dir/mutagen.env}"
out_dir="${CORE_OUT_DIR:-$dir/semantic}"
seeds=("натяжные потолки" "потолки под ключ")

set -a
# shellcheck source=/dev/null
. "$env_file"
set +a

mkdir -p "$out_dir"
date_tag="$(date +%F)"

mutagen-ru core "${seeds[@]}" --budget "${MUTAGEN_BUDGET_RUB:-20}" --yes -q \
  -o "$out_dir/core-$date_tag.csv"
cp "$out_dir/core-$date_tag.csv" "$out_dir/core-latest.csv"

mutagen-ru spending --format csv -q > "$out_dir/spending-$date_tag.csv"
echo "$(date '+%F %T') core saved: $out_dir/core-$date_tag.csv"
