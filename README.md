# LEIAUT Vertex AI

Cópia independente do LEIAUT para converter Markdown em JSON estruturado usando exclusivamente a API Gemini no Vertex AI.

## Requisitos

- Node.js 20 ou superior.
- Projeto Google Cloud com faturamento vinculado.
- Vertex AI API habilitada.
- Service Account com a role `roles/aiplatform.user`, ou ADC de usuário autorizado.

## Instalação

```powershell
cd C:\PRO\leiaut
npm.cmd install
Copy-Item .env.example .env
```

Edite somente os valores não sensíveis no `.env`:

```env
GOOGLE_CLOUD_PROJECT=seu-project-id
GOOGLE_CLOUD_LOCATION=us-central1
VERTEX_MODEL=gemini-2.5-flash
LEIAUT_BLOCK_INPUT_TOKENS=5000
LEIAUT_TIMEOUT_MS=180000
```

## Autenticação

### Service Account

Crie uma Service Account específica e conceda apenas `roles/aiplatform.user`. Armazene o JSON fora deste projeto e configure na sessão:

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS = "C:\caminho-seguro\vertex-leiaut.json"
```

### ADC de usuário para desenvolvimento local

```powershell
gcloud auth application-default login
gcloud config set project seu-project-id
```

O código sempre instancia `GoogleGenAI` com `vertexai: true`. As variáveis `GEMINI_API_KEY` e `GOOGLE_API_KEY` não são lidas e não ativam fallback para Google AI Studio.

## Preparação do GCP

```powershell
gcloud services enable aiplatform.googleapis.com --project seu-project-id
```

Confirme no Console do Google Cloud que o projeto está associado à conta de faturamento que contém os créditos. Configure alertas de orçamento para 50%, 75% e 90%.

## Uso

```powershell
npm.cmd run leiaut -- caminho\arquivo.md
```

O arquivo de saída será criado no diretório atual como `arquivo_processado.json`.

Quando a primeira linha útil do Markdown usa `@@ Título` ou `@@@ Título`, esse texto é o título canônico do material e é copiado literalmente para `topic_title`, sem correção ortográfica, capitalização ou reescrita. A regra não se aplica aos cabeçalhos Markdown de subtítulos e seções (`##`, `###` e inferiores), que continuam seguindo a normalização editorial existente. Na ausência do marcador de título, permanece o fallback compatível pelo primeiro cabeçalho ou pelo nome do arquivo.

Também é possível informar um diretório. Nesse modo, o LEIAUT processa sequencialmente
somente os arquivos `.md` diretamente dentro da pasta, em ordem numérica, e ignora
arquivos auxiliares e subdiretórios:

```powershell
npm.cmd run leiaut -- C:\caminho\pasta-com-markdown
```

Os JSONs do lote serão salvos no diretório atual, dentro de
`pasta-com-markdown_processado`. Se um arquivo falhar, os demais continuam sendo
processados e o resumo final identifica cada falha. O processo termina com código de
saída diferente de zero quando pelo menos um arquivo do lote não é concluído.
Se já existir um JSON de uma execução anterior para um arquivo que falhou, ele é
preservado, mas o resumo o identifica explicitamente como saída antiga. Esse arquivo
não deve ser confundido com um sucesso nem importado como resultado do lote atual.

O LEIAUT mantém o processamento sequencial com alvo de aproximadamente 5.000 tokens por bloco. A divisão ocorre somente entre seções principais `##`: o conteúdo anterior ao primeiro `##` acompanha essa primeira seção, e cabeçalhos `###` e inferiores permanecem dentro da seção pai. Tanto arquivos completos de bloco único quanto arquivos fracionados recebem no prompt a quantidade, a ordem e os títulos `##` exatos da respectiva fonte; cada prompt recebe somente o outline do conteúdo enviado. Uma seção `##` indivisível entre 5.000 e 10.000 tokens é enviada sozinha, sem ser misturada com seções vizinhas. Acima do teto seguro de 10.000 tokens, o processo é interrompido com erro claro em vez de cortar a hierarquia no meio. O teto pode ser ajustado conscientemente por `LEIAUT_MAX_SECTION_TOKENS`, sem ultrapassar `LEIAUT_MAX_INPUT_TOKENS`.

Antes de qualquer chamada ao Vertex AI, marcadores técnicos exatos `## Recuperação de bloco` e `@@@ Recuperação de bloco`, produzidos por recuperação do PYGEM, são ignorados em memória sem remover o conteúdo ao redor. O Markdown é recusado quando contém linha patológica, sequência excessiva de espaços ou título principal duplicado. Na saída, o LEIAUT exige exatamente uma seção JSON por cabeçalho `##`, na mesma ordem. Se a IA omitir somente um qualificador entre parênteses ou variar apenas a abreviação jurídica `art.`/`arts.` antes do mesmo número, o título literal é restaurado da fonte; números, palavras ou demais divergências reais continuam sendo rejeitados. Títulos em caixa alta são normalizados para capitalização editorial, preservando siglas como `CIDE`, `ICMS`, `ISS`, `NBC TA` e `TI`; o erro conhecido `DOUTINA` é corrigido para `doutrina`.

Erros transitórios `429`, `500` e `503` usam no máximo duas novas tentativas, com
backoff exponencial truncado, jitter e respeito ao cabeçalho `Retry-After` quando ele
estiver disponível. Erros de validação, autenticação, entrada, timeout ou cancelamento
não são repetidos automaticamente. Entre requisições existe um cooldown curto para
suavizar picos de tráfego no processamento em lote.

Se o modelo devolver uma seção totalmente vazia, o LEIAUT procura um cabeçalho de
mesmo título na fonte. O corpo Markdown literal só é restaurado quando a correspondência
é única e possui conteúdo; títulos ausentes, duplicados ou ambíguos continuam falhando.

## Saída antes do diagnóstico

O pipeline normaliza o contrato, remove subtítulos Markdown órfãos, confere a estrutura contra os títulos `##` da fonte e limpa o Mermaid antes de gravar o JSON consolidado. Depois da gravação, uma análise somente leitura gera `*_processado_diagnostico.log` com erros, avisos e informações para tratamento posterior. O diagnóstico nunca modifica nem apaga o JSON já salvo; ele não substitui a validação estrutural aplicada antes da persistência.

## Mnemônicos

A análise editorial de mnemônicos pertence ao aplicativo de escrita PYGEM. O LEIAUT não aplica heurísticas, censura ou gate de reprovação para mnemônicos. Quando a fonte contiver itens explicitamente estruturáveis, eles são transportados para `sections[].mnemonics`; quando não houver, o campo permanece como array vazio. A validação local limita-se ao formato exigido pelo contrato JSON (`key`, `meaning` e `description`).

## Modos sem IA

Gerar estrutura determinística sem chamar o Vertex AI:

```powershell
npm.cmd run leiaut -- arquivo.md --no-ai
```

Separar por tópicos `##`, também sem IA:

```powershell
npm.cmd run leiaut -- arquivo.md --split-by-topic
```

## Testes

```powershell
npm.cmd test
npm.cmd run check
```

Os testes não realizam chamadas de rede nem exigem credenciais.

## Variáveis

| Variável | Obrigatória | Padrão | Finalidade |
|---|---:|---|---|
| `GOOGLE_CLOUD_PROJECT` | Sim, no modo IA | — | Projeto GCP usado para cobrança e quota |
| `GOOGLE_CLOUD_LOCATION` | Não | `us-central1` | Região do endpoint Vertex AI |
| `VERTEX_MODEL` | Não | `gemini-2.5-flash` | ID do modelo no Vertex AI |
| `GOOGLE_APPLICATION_CREDENTIALS` | Não, se ADC já existir | — | Caminho externo para JSON de Service Account |
| `LEIAUT_BLOCK_INPUT_TOKENS` | Não | `5000` | Teto-alvo de cada bloco |
| `LEIAUT_MAX_INPUT_TOKENS` | Não | `30000` | Teto de segurança por bloco |
| `LEIAUT_MAX_SECTION_TOKENS` | Não | `10000` | Teto de seção `##` indivisível |
| `LEIAUT_TIMEOUT_MS` | Não | `180000` | Timeout por chamada |
| `LEIAUT_MAX_RETRIES` | Não | `2` | Novas tentativas transitórias; limitado de `0` a `2` |
| `LEIAUT_RETRY_BASE_DELAY_MS` | Não | `10000` | Espera-base do backoff exponencial |
| `LEIAUT_RETRY_MAX_DELAY_MS` | Não | `60000` | Teto do backoff, salvo `Retry-After` maior |
| `LEIAUT_REQUEST_COOLDOWN_MS` | Não | `2000` | Intervalo mínimo após uma requisição antes da próxima |
| `LEIAUT_MIN_OUTPUT_TOKENS` | Não | `4096` | Piso do orçamento de saída por resposta |
| `LEIAUT_MAX_OUTPUT_TOKENS` | Não | `65536` | Teto do orçamento de saída, limitado a `65536` |
| `LEIAUT_OUTPUT_TOKEN_MULTIPLIER` | Não | `2` | Proporção inicial entre tokens do prompt e da resposta |
| `LEIAUT_OUTPUT_TOKEN_RETRY_MULTIPLIER` | Não | `2` | Crescimento do orçamento após `MAX_TOKENS` |
| `LEIAUT_MAX_OUTPUT_TOKEN_RETRY_MULTIPLIER` | Não | `4` | Limite acumulado de crescimento nas retentativas |

Respostas encerradas por `MAX_TOKENS` não são interpretadas nem publicadas parcialmente. O LEIAUT aumenta o orçamento somente nas retentativas causadas por truncagem; erros transitórios de capacidade preservam o orçamento calculado.

## Modelo

O padrão é `gemini-2.5-flash`, modelo documentado no Vertex AI. Para trocar de modelo, use `VERTEX_MODEL` com um ID disponível no mesmo projeto e região. Não use IDs presumidos ou nomes comerciais que não apareçam na documentação do Vertex AI.
