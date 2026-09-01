# Changelog

## 2026-09-01 — compatibilidade de Markdown com a importação

- converte tags `<br>` introduzidas em Markdown para separadores seguros antes da publicação no contrato do site.

## 2026-09-01 — preservação do preâmbulo Markdown

- restaura deterministicamente, na primeira seção JSON, o conteúdo existente antes do primeiro cabeçalho `##`;
- preserva subtítulos, exemplos e fórmulas KaTeX do preâmbulo sem duplicá-los em reprocessamentos.
- restaura siglas qualificadoras de títulos omitidas pelo modelo antes de citações legais.
- impede que o reparo OCR una preposições curtas legítimas, como `Conta de`, em títulos limpos.
- restaura conjuntamente sigla e citação legal quando ambas forem omitidas em um título posicionalmente equivalente.
- aplica também aos mnemônicos o máximo global definido pelo manifesto visual antes do gate de publicação.
- reconcilia a expansão controlada de `Adm.` para `Administração` e restaura o título literal da fonte.

## 2026-08-31 — ordinais idempotentes em mapas Mermaid

- impede que a normalização iterativa de linhas do tempo repita os prefixos `01 ·`, `02 ·` e equivalentes;
- adiciona regressão para garantir que uma segunda normalização produza exatamente o mesmo diagrama.

## 2026-08-28 — rastreabilidade de flashcards

- exige questão C/E com banca, ano, concurso/cargo, identificador e status válido/não anulado; cartões sem origem são descartados antes da publicação.

## 2026-08-28 — rótulos automáticos removidos de Mermaid

- remove os rótulos genéricos `inicia em` e `prossegue para` das arestas sequenciais;
- limpa esses rótulos de diagramas legados durante a normalização;
- orienta novas gerações a rotular setas somente quando houver relação didática específica.

## 2026-08-27 — cardinalidade global de realces

- limita callouts ao máximo global definido pelo manifesto visual, inclusive quando o teto é maior que um.
- restaura títulos de seção a partir do cabeçalho literal da fonte sem aplicar reparo de fragmentação OCR sobre texto já limpo.
- remove enriquecimentos de flashcard individualmente reprovados antes de persistir o JSON, preservando os cartões válidos.
- repete a normalização segura de Mermaid até convergir, evitando JSON que ainda exigiria nova limpeza.
- diferencia flashcards em blockquote de realces visuais e compacta `mindmap` denso quando o manifesto exige transportar o diagrama.
- restaura também o `topic_title` a partir do título documental limpo, sem aplicar reparo OCR destrutivo.
- recupera tabelas Markdown omitidas pelo modelo na seção-fonte correspondente quando o manifesto visual exige preservação.
- substitui tabelas excedentes pelo conjunto literal da fonte quando o máximo do manifesto seria ultrapassado.
- aceita referências numéricas e a preposição `em` em slugs canônicos sem classificá-las como fragmentação OCR.
- restaura símbolos corrompidos que substituam letras em títulos de seção quando o pareamento posicional com a fonte for inequívoco.

## 2026-08-27 — limpeza de metadados de título

- remove sufixos técnicos `[arquivo: NNN]` e corrige o erro OCR conhecido `Tiposde` nos títulos canônicos.

## 2026-08-27 — transporte de fórmulas KaTeX

- preserva fórmulas quantitativas em KaTeX no `content_markdown`, com variáveis definidas no contexto adjacente.

## 2026-08-27 — saneamento de metadados de conteúdo

- corrige rótulos conhecidos de disciplina corrompidos por caracteres `?` e bloqueia novos valores ainda corrompidos;
- normaliza `Língua Portugues` para `Língua Portuguesa` sem remover sufixos de lote;
- remove o marcador documental inicial `@@`/`@@@` do corpo de seções antes da gravação do JSON.

## 2026-08-26 — local de saída para arquivo único e lote

- documenta e testa `--output-dir` para escolher a pasta dos arquivos gerados nos dois modos de processamento;
- centraliza a resolução de caminhos relativos e rejeita a opção sem valor.

## 2026-08-26 — robustez de títulos OCR e disciplina explícita

- aceita `--discipline` como autoridade para processamento individual e em lote;
- compara títulos com fragmentação OCR conservadora, sem relaxar divergências reais de estrutura.

## 2026-08-26 — saída configurável em lote

- adiciona `--output-dir` ao processamento Markdown para permitir definir a pasta de saída sem alterar o formato dos JSONs.

## 2026-08-25 — migração do Vertex AI para Gemini 3.5

- altera o modelo padrão de `gemini-2.5-flash` para `gemini-3.5-flash` no endpoint `global`;
- usa `thinkingLevel=MINIMAL` com Gemini 3 e preserva `thinkingBudget` para 2.5 explicitamente configurado;
- adiciona `.env.example` sem credenciais e atualiza a orientação operacional.

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
