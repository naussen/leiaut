# AGENTS.md — LEIAUT

## Regras do ecossistema

Este projeto participa do fluxo de preparação de conteúdo para PYGEM, SITE_ANTIG e TESOURA. O agente deve:

- preservar o contrato de transformação de Markdown em JSON estruturado;
- não introduzir mudanças que dificultem a posterior reescrita, importação ou leitura do conteúdo;
- manter o processamento local e seguro, sem enviar arquivos para servidores externos;
- evitar alterações que gerem perda de conteúdo, nomes inconsistentes ou quebra de ordem das seções;
- validar o resultado antes de concluir qualquer ajuste.

## Escopo

O agente está autorizado a criar e alterar arquivos dentro de `C:\leiaut`.

Não criar, alterar ou apagar arquivos fora deste diretório.

## Segurança

Não ler ou modificar credenciais, arquivos `.env`, tokens, chaves, contas de serviço ou conteúdo interno de `.git`.

## Qualidade

Antes de alterar arquivos:

1. analisar o estado atual;
2. explicar o plano;
3. identificar os riscos;
4. limitar o escopo;
5. implementar e verificar.

## Regras específicas do projeto

- preservar a estrutura JSON esperada pelo pipeline de importação;
- manter os títulos de seção, a ordem e a hierarquia do conteúdo;
- não alterar o sentido jurídico ou doutrinário do material sem autorização explícita;
- não simplificar validações de forma que comprometa a integridade dos dados;
- validar as mudanças com os testes locais relevantes, como `npm test` e `npm run check`, sempre que aplicável.
