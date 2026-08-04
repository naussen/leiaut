# LEIAUT Vertex AI

Cópia independente do LEIAUT para converter Markdown em JSON estruturado usando exclusivamente a API Gemini no Vertex AI.

## Requisitos

- Node.js 20 ou superior.
- Projeto Google Cloud com faturamento vinculado.
- Vertex AI API habilitada.
- Service Account com a role `roles/aiplatform.user`, ou ADC de usuário autorizado.

## Instalação

```powershell
cd C:\leiaut
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

O arquivo de saída será criado em `C:\site_conteudo\3leiaut_processado\<nome-da-pasta-originária>\arquivo_processado.json`. Por exemplo, a entrada `C:\materiais\Contabilidade\001.md` gera `C:\site_conteudo\3leiaut_processado\Contabilidade\001_processado.json`.

O LEIAUT mantém o processamento sequencial em blocos de até aproximadamente 5.000 tokens. A divisão preferencial ocorre entre seções principais `##`, mantendo cabeçalhos `###` e inferiores dentro da seção pai. Quando uma única seção `##` excede o teto, ela pode ser repartida apenas em limites seguros de subtítulos ou parágrafos, com o título `##` repetido nos fragmentos para preservar o contexto. Os fragmentos da mesma seção são consolidados antes da validação final, que continua exigindo exatamente uma seção JSON por `##`. Se não houver limite seguro, o processo é interrompido com erro claro em vez de cortar uma palavra ou estrutura no meio.

Antes de qualquer chamada ao Vertex AI, o Markdown é recusado quando contém linha patológica, sequência excessiva de espaços ou título principal duplicado. Na saída, o LEIAUT exige exatamente uma seção JSON por cabeçalho `##`, na mesma ordem. Títulos em caixa alta são normalizados para capitalização editorial, preservando siglas como `CIDE`, `ICMS`, `ISS`, `NBC TA` e `TI`; o erro conhecido `DOUTINA` é corrigido para `doutrina`.

Os flashcards estruturados são gerados pelo LEIAUT em grupos de 3 a 5 por seção quando houver bases distintas suficientes. Cada cartão deve derivar de questão de concurso identificável no material ou de redação legal expressa presente na própria seção. Se nenhuma dessas bases existir, o campo permanece como `flashcards: []`; o modelo não deve inventar cartões para preencher uma quantidade mínima.

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
| `LEIAUT_TIMEOUT_MS` | Não | `180000` | Timeout por chamada |

## Modelo

O padrão é `gemini-2.5-flash`, modelo documentado no Vertex AI. Para trocar de modelo, use `VERTEX_MODEL` com um ID disponível no mesmo projeto e região. Não use IDs presumidos ou nomes comerciais que não apareçam na documentação do Vertex AI.
