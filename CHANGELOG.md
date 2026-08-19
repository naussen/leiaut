# Changelog

## 2026-08-19

- separa as tentativas por indisponibilidade transitória das tentativas por `MAX_TOKENS`;
- amplia de forma limitada o orçamento de saída após truncamentos sucessivos;
- desabilita o orçamento de raciocínio por padrão na transformação estruturada;
- registra metadados de uso de tokens para diagnóstico de truncamento;
- normaliza títulos editoriais sem tratar a própria linha de título como contexto de sigla;
- adiciona testes unitários para títulos, retries independentes e orçamento de saída.
