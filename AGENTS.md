# AGENTS.md — LEIAUT Vertex AI

## Escopo

Este diretório contém uma cópia independente do conversor LEIAUT, configurada exclusivamente para Vertex AI.

## Segurança

- Nunca adicionar API Keys, arquivos `.env`, JSON de Service Account, tokens ou credenciais ao projeto.
- Autenticar por Application Default Credentials (ADC) ou `GOOGLE_APPLICATION_CREDENTIALS`.
- Não adicionar fallback para Gemini Developer API/Google AI Studio.
- Não registrar conteúdo de credenciais nem o caminho completo da Service Account.

## Compatibilidade

- Manter o contrato JSON de `topic_id`, `discipline`, `topic_title` e `sections`.
- Preservar Structured Outputs, processamento em blocos e validações pós-processamento.
- IDs usam hífens e seções seguem `{topic_id}-sec-NN`.

## Qualidade

- Fazer mudanças pequenas e incrementais.
- Rodar `npm test` e `npm run check` antes de entregar.
- Não realizar chamada real ao Vertex AI nos testes unitários.
