# LEIAUT Vertex AI

C¢pia independente do LEIAUT para converter Markdown em JSON estruturado usando exclusivamente a API Gemini no Vertex AI.

## Requisitos

- Node.js 20 ou superior.
- Projeto Google Cloud com faturamento vinculado.
- Vertex AI API habilitada.
- Service Account com a role `roles/aiplatform.user`, ou ADC de usu†rio autorizado.

## Instalaá∆o

```powershell
cd C:\PRO\leiaut
npm.cmd install
Copy-Item .env.example .env
```

Edite somente os valores n∆o sens°veis no `.env`:

```env
GOOGLE_CLOUD_PROJECT=seu-project-id
GOOGLE_CLOUD_LOCATION=us-central1
VERTEX_MODEL=gemini-2.5-flash
LEIAUT_BLOCK_INPUT_TOKENS=5000
LEIAUT_TIMEOUT_MS=180000
```

## Autenticaá∆o

### Service Account

Crie uma Service Account espec°fica e conceda apenas `roles/aiplatform.user`. Armazene o JSON fora deste projeto e configure na sess∆o:

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS = "C:\caminho-seguro\vertex-leiaut.json"
```

### ADC de usu†rio para desenvolvimento local

```powershell
gcloud auth application-default login
gcloud config set project seu-project-id
```

O c¢digo sempre instancia `GoogleGenAI` com `vertexai: true`. As vari†veis `GEMINI_API_KEY` e `GOOGLE_API_KEY` n∆o s∆o lidas e n∆o ativam fallback para Google AI Studio.

## Preparaá∆o do GCP

```powershell
gcloud services enable aiplatform.googleapis.com --project seu-project-id
```

Confirme no Console do Google Cloud que o projeto est† associado Ö conta de faturamento que contÇm os crÇditos. Configure alertas de oráamento para 50%, 75% e 90%.

## Uso

```powershell
npm.cmd run leiaut -- caminho\arquivo.md
```

O arquivo de sa°da ser† criado no diret¢rio atual como `arquivo_processado.json`.

Quando a primeira linha £til do Markdown usa `@@ T°tulo` ou `@@@ T°tulo`, esse texto Ç o t°tulo canìnico do material e Ç copiado literalmente para `topic_title`, sem correá∆o ortogr†fica, capitalizaá∆o ou reescrita. A regra n∆o se aplica aos cabeáalhos Markdown de subt°tulos e seá‰es (`##`, `###` e inferiores), que continuam seguindo a normalizaá∆o editorial existente. Na ausància do marcador de t°tulo, permanece o fallback compat°vel pelo primeiro cabeáalho ou pelo nome do arquivo.

TambÇm Ç poss°vel informar um diret¢rio. Nesse modo, o LEIAUT processa sequencialmente
somente os arquivos `.md` diretamente dentro da pasta, em ordem numÇrica, e ignora
arquivos auxiliares e subdiret¢rios:

```powershell
npm.cmd run leiaut -- C:\caminho\pasta-com-markdown
```

Os JSONs do lote ser∆o salvos no diret¢rio atual, dentro de
`pasta-com-markdown_processado`. Se um arquivo falhar, os demais continuam sendo
processados e o resumo final identifica cada falha. O processo termina com c¢digo de
sa°da diferente de zero quando pelo menos um arquivo do lote n∆o Ç conclu°do.
Se j† existir um JSON de uma execuá∆o anterior para um arquivo que falhou, ele Ç
preservado, mas o resumo o identifica explicitamente como sa°da antiga. Esse arquivo
n∆o deve ser confundido com um sucesso nem importado como resultado do lote atual.

O LEIAUT mantÇm o processamento sequencial com alvo de aproximadamente 5.000 tokens por bloco. A divis∆o ocorre somente entre seá‰es principais `##`: o conte£do anterior ao primeiro `##` acompanha essa primeira seá∆o, e cabeáalhos `###` e inferiores permanecem dentro da seá∆o pai. Tanto arquivos completos de bloco £nico quanto arquivos fracionados recebem no prompt a quantidade, a ordem e os t°tulos `##` exatos da respectiva fonte; cada prompt recebe somente o outline do conte£do enviado. Uma seá∆o `##` indivis°vel entre 5.000 e 10.000 tokens Ç enviada sozinha, sem ser misturada com seá‰es vizinhas. Acima do teto seguro de 10.000 tokens, o processo Ç interrompido com erro claro em vez de cortar a hierarquia no meio. O teto pode ser ajustado conscientemente por `LEIAUT_MAX_SECTION_TOKENS`, sem ultrapassar `LEIAUT_MAX_INPUT_TOKENS`.

Antes de qualquer chamada ao Vertex AI, marcadores tÇcnicos exatos `## Recuperaá∆o de bloco` e `@@@ Recuperaá∆o de bloco`, produzidos por recuperaá∆o do PYGEM, s∆o ignorados em mem¢ria sem remover o conte£do ao redor. O Markdown Ç recusado quando contÇm linha patol¢gica, sequància excessiva de espaáos ou t°tulo principal duplicado. Na sa°da, o LEIAUT exige exatamente uma seá∆o JSON por cabeáalho `##`, na mesma ordem. Se a IA omitir somente um qualificador entre parànteses ou variar apenas a abreviaá∆o jur°dica `art.`/`arts.` antes do mesmo n£mero, o t°tulo literal Ç restaurado da fonte; n£meros, palavras ou demais divergàncias reais continuam sendo rejeitados. T°tulos em caixa alta s∆o normalizados para capitalizaá∆o editorial, preservando siglas como `CIDE`, `ICMS`, `ISS`, `NBC TA` e `TI`; o erro conhecido `DOUTINA` Ç corrigido para `doutrina`.

Erros transit¢rios `429`, `500` e `503` usam no m†ximo duas novas tentativas, com
backoff exponencial truncado, jitter e respeito ao cabeáalho `Retry-After` quando ele
estiver dispon°vel. Erros de validaá∆o, autenticaá∆o, entrada, timeout ou cancelamento
n∆o s∆o repetidos automaticamente. Entre requisiá‰es existe um cooldown curto para
suavizar picos de tr†fego no processamento em lote.

Se o modelo devolver uma seá∆o totalmente vazia, o LEIAUT procura um cabeáalho de
mesmo t°tulo na fonte. O corpo Markdown literal s¢ Ç restaurado quando a correspondància
Ç £nica e possui conte£do; t°tulos ausentes, duplicados ou amb°guos continuam falhando.

## Sa°da antes do diagn¢stico

O pipeline normaliza o contrato, remove subt°tulos Markdown ¢rf∆os, confere a estrutura contra os t°tulos `##` da fonte e limpa o Mermaid antes de gravar o JSON consolidado. Depois da gravaá∆o, uma an†lise somente leitura gera `*_processado_diagnostico.log` com erros, avisos e informaá‰es para tratamento posterior. O diagn¢stico nunca modifica nem apaga o JSON j† salvo; ele n∆o substitui a validaá∆o estrutural aplicada antes da persistància.

## Mnemìnicos

A an†lise editorial de mnemìnicos pertence ao aplicativo de escrita PYGEM. O LEIAUT n∆o aplica heur°sticas, censura ou gate de reprovaá∆o para mnemìnicos. Quando a fonte contiver itens explicitamente estrutur†veis, eles s∆o transportados para `sections[].mnemonics`; quando n∆o houver, o campo permanece como array vazio. A validaá∆o local limita-se ao formato exigido pelo contrato JSON (`key`, `meaning` e `description`).

## Modos sem IA

Gerar estrutura determin°stica sem chamar o Vertex AI:

```powershell
npm.cmd run leiaut -- arquivo.md --no-ai
```

Separar por t¢picos `##`, tambÇm sem IA:

```powershell
npm.cmd run leiaut -- arquivo.md --split-by-topic
```

## Testes

```powershell
npm.cmd test
npm.cmd run check
```

Os testes n∆o realizam chamadas de rede nem exigem credenciais.

## Vari†veis

| Vari†vel | Obrigat¢ria | Padr∆o | Finalidade |
|---|---:|---|---|
| `GOOGLE_CLOUD_PROJECT` | Sim, no modo IA | - | Projeto GCP usado para cobranáa e quota |
| `GOOGLE_CLOUD_LOCATION` | N∆o | `us-central1` | Regi∆o do endpoint Vertex AI |
| `VERTEX_MODEL` | N∆o | `gemini-2.5-flash` | ID do modelo no Vertex AI |
| `GOOGLE_APPLICATION_CREDENTIALS` | N∆o, se ADC j† existir | - | Caminho externo para JSON de Service Account |
| `LEIAUT_BLOCK_INPUT_TOKENS` | N∆o | `5000` | Teto-alvo de cada bloco |
| `LEIAUT_MAX_INPUT_TOKENS` | N∆o | `30000` | Teto de seguranáa por bloco |
| `LEIAUT_MAX_SECTION_TOKENS` | N∆o | `10000` | Teto de seá∆o `##` indivis°vel |
| `LEIAUT_TIMEOUT_MS` | N∆o | `180000` | Timeout por chamada |
| `LEIAUT_MAX_RETRIES` | N∆o | `2` | Novas tentativas transit¢rias; limitado de `0` a `2` |
| `LEIAUT_RETRY_BASE_DELAY_MS` | N∆o | `10000` | Espera-base do backoff exponencial |
| `LEIAUT_RETRY_MAX_DELAY_MS` | N∆o | `60000` | Teto do backoff, salvo `Retry-After` maior |
| `LEIAUT_REQUEST_COOLDOWN_MS` | N∆o | `2000` | Intervalo m°nimo ap¢s uma requisiá∆o antes da pr¢xima |
| `LEIAUT_MIN_OUTPUT_TOKENS` | N∆o | `4096` | Piso do oráamento de sa°da por resposta |
| `LEIAUT_MAX_OUTPUT_TOKENS` | N∆o | `65536` | Teto do oráamento de sa°da, limitado a `65536` |
| `LEIAUT_OUTPUT_TOKEN_MULTIPLIER` | N∆o | `2` | Proporá∆o inicial entre tokens do prompt e da resposta |
| `LEIAUT_OUTPUT_TOKEN_RETRY_MULTIPLIER` | N∆o | `2` | Crescimento do oráamento ap¢s `MAX_TOKENS` |
| `LEIAUT_MAX_OUTPUT_TOKEN_RETRY_MULTIPLIER` | N∆o | `4` | Limite acumulado de crescimento nas retentativas |

Respostas encerradas por `MAX_TOKENS` n∆o s∆o interpretadas nem publicadas parcialmente. O LEIAUT aumenta o oráamento somente nas retentativas causadas por truncagem; erros transit¢rios de capacidade preservam o oráamento calculado.

## Modelo

O padr∆o Ç `gemini-2.5-flash`, modelo documentado no Vertex AI. Para trocar de modelo, use `VERTEX_MODEL` com um ID dispon°vel no mesmo projeto e regi∆o. N∆o use IDs presumidos ou nomes comerciais que n∆o apareáam na documentaá∆o do Vertex AI.
