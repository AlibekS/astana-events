# Правила проекта

## GitHub Actions
- Используй только версии actions на Node.js 24 — устаревшие (node20) дают предупреждения в каждом запуске.
  Текущие: `actions/checkout@v7`, `actions/setup-python@v7`, `actions/configure-pages@v6`,
  `actions/upload-pages-artifact@v5`, `actions/deploy-pages@v5`.
- Перед добавлением нового action или обновлением проверь его последний major-тег и `runs.using` в `action.yml`
  (должно быть `node24` или `composite`/`docker`).
