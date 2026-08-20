# Changelog

## 2026-08-19 — manifesto visual

- adiciona leitura de `_visual-plan.json` e `--visual-manifest` com validação de hash;
- injeta instrução restrita de preservação de recursos visuais no prompt do LEIAUT;
- compara recursos do Markdown com o JSON e gera relatório `.visual-validation.json` sem conteúdo privado;
- associa tópicos do manifesto por `source_index` ou título canônico.
- transforma divergência visual obrigatória em erro antes da gravação;
- preserva JSON anterior quando a validação visual falha;
- grava JSONs aprovados por arquivo temporário e renomeação atômica.
- usa `topic_slug` aprovado no manifesto como autoridade do `topic_id`;
- rejeita slugs fragmentados, ambíguos ou duplicados no lote;
- expõe mapa explícito para migração `topic_id` antigo → novo, sem alterar banco.
- ajusta o detector de slug para não tratar conectores editoriais como fragmentação OCR.
- restringe no prompt a cardinalidade global dos recursos e recupera Mermaid obrigatório em formato compacto seguro quando o modelo excede o limite.

## 2026-08-19

- separa as tentativas por indisponibilidade transitória das tentativas por `MAX_TOKENS`;
- amplia de forma limitada o orçamento de saída após truncamentos sucessivos;
- desabilita o orçamento de raciocínio por padrão na transformação estruturada;
- registra metadados de uso de tokens para diagnóstico de truncamento;
- normaliza títulos editoriais sem tratar a própria linha de título como contexto de sigla;
- adiciona testes unitários para títulos, retries independentes e orçamento de saída.
