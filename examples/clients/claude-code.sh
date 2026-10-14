#!/usr/bin/env bash
# Подключение mutagen-ru-mcp к Claude Code для всех проектов (--scope user).
claude mcp add --env MUTAGEN_API_KEY=ваш_ключ --env MUTAGEN_BUDGET_RUB=50 \
  --transport stdio --scope user mutagen -- npx -y mutagen-ru-mcp
