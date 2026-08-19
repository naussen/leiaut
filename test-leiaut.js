/**
 * Testes unitários — Módulo LEIAUT (validateAndNormalizeOutput + cleanMermaidCode)
 * 
 * Cobre cenários de sucesso, edge cases e as 5 divergências
 * documentadas no PLANO_ADEQUACAO_LEIAUT.md.
 * 
 * Execução: node test-leiaut.js
 */

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const nodeAssert = require('assert');
const {
  validateAndNormalizeOutput,
  normalizeMarkdownTransportNewlines,
  normalizeMermaidTransportNewlines,
  normalizeContentTransportArtifacts,
  normalizeStudyTitle,
  normalizeInlineTopicMarkers,
  removePygemRecoveryMarkers,
  removeOrphanMarkdownHeadings,
  validateMarkdownInput,
  assertSectionStructureMatchesSource,
  canonicalizeSectionTitlesFromSource,
  recoverEmptySectionsFromSource,
  assertImportableSections,
  cleanMermaidCode,
  parseLeiautArgs,
  resolveMarkdownInputPaths,
  slugify,
  inferDiscipline,
  inferDisciplineFromFileName,
  extractOriginalDocumentTitle,
  getCanonicalTopicTitle,
  getLevelTwoHeadingTitles,
  buildDeterministicOutputs,
  writeJsonOutput,
  buildLeiautBlockPrompt,
  mergeLeiautBlockData,
  collectPostGenerationDiagnostics,
  formatDiagnosticsLog,
  getVertexErrorStatus,
  isRetryableVertexError,
  shouldRetryVertexFailure,
  getRetryAfterMs,
  calculateRetryDelayMs,
  getVertexFinishReason,
  getVertexTokenUsage,
  calculateFlexibleOutputTokens,
} = require('./src/app-leiaut');
const { splitContentIntoBlocks } = require('./src/services/tokenService');
const {
  loadVisualManifest,
  buildVisualPromptInstruction,
} = require('./src/visual/visualManifestReader');
const {
  observeMarkdownResources,
  observeJsonResources,
  validateVisualManifestOutput,
  writeVisualValidationReport,
} = require('./src/visual/visualComplianceValidator');

// ============================================================
// Mini framework de teste
// ============================================================
let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, testName) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${testName}`);
  } else {
    failed++;
    failures.push(testName);
    console.error(`  ❌ ${testName}`);
  }
}

// ============================================================
// Contrato visual PYGEM -> LEIAUT
// ============================================================
{
  const visualDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leiaut-visual-'));
  try {
    const inputPath = path.join(visualDir, '010_teste.md');
    const planPath = path.join(visualDir, '_visual-plan.json');
    const markdown = [
      '## Teste visual', '',
      '| Regra | Valor |', '| --- | --- |', '| A | B |', '',
      '### Fluxo', '', '```mermaid', 'flowchart TD', 'A --> B', '```', '',
      '> **Atenção:** preserve a regra.', '',
      '**Mnemônico:** ABC.',
    ].join('\n');
    const plan = {
      schema_version: 1,
      guide_id: 'teste-visual-v1',
      guide_sha256: '0'.repeat(64),
      diversification_seed: 'teste-v1',
      topics: [{
        source_index: '010',
        canonical_title: 'Teste visual',
        topic_slug: 'teste-visual',
        requirements: [
          { resource: 'table', semantic_role: 'comparison', required: true, minimum: 1, maximum: 1 },
          { resource: 'mermaid', semantic_role: 'process_flow', required: true, minimum: 1, maximum: 1 },
          { resource: 'highlight', semantic_role: 'rule', required: true, minimum: 1, maximum: 1 },
          { resource: 'mnemonic', semantic_role: 'memory_key', required: true, minimum: 1, maximum: 1 },
        ],
      }],
    };
    fs.writeFileSync(inputPath, markdown, 'utf8');
    fs.writeFileSync(planPath, `${JSON.stringify(plan)}\n`, 'utf8');
    const context = loadVisualManifest({ inputPath, markdown });
    assert(context && context.topics.length === 1, 'Manifesto visual irmão é descoberto e associado');
    assert(buildVisualPromptInstruction(context).includes('Não substitua tabela por Mermaid'), 'Prompt restringe substituição de recurso visual');
    nodeAssert.deepStrictEqual(observeMarkdownResources(markdown), { table: 1, mermaid: 1, highlight: 1, mnemonic: 1 });
    const data = {
      sections: [{
        title: 'Teste visual',
        content_markdown: '| Regra | Valor |\n| --- | --- |\n| A | B |',
        callouts: [{ type: 'warning', title: 'Atenção', text: 'Preserve a regra.' }],
        mnemonics: [{ key: 'ABC', meaning: 'Regra', description: 'Memória.' }],
        flashcards: [],
        mermaid_mindmap: 'flowchart TD\nA --> B',
      }],
    };
    nodeAssert.deepStrictEqual(observeJsonResources(data), { table: 1, mermaid: 1, highlight: 1, mnemonic: 1 });
    const result = validateVisualManifestOutput(data, markdown, context);
    assert(result.valid, 'Saída JSON compatível com manifesto deve ser aceita');
    const reportPath = writeVisualValidationReport(path.join(visualDir, 'saida.json'), context, result);
    assert(fs.existsSync(reportPath), 'Relatório visual agregado é gravado');
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert(!Object.hasOwn(report, 'content_markdown'), 'Relatório não contém conteúdo privado');
    const atomicOutputPath = path.join(visualDir, 'atomic.json');
    writeJsonOutput(atomicOutputPath, { version: 1 });
    writeJsonOutput(atomicOutputPath, { version: 2 });
    nodeAssert.strictEqual(JSON.parse(fs.readFileSync(atomicOutputPath, 'utf8')).version, 2);
    assert(!fs.readdirSync(visualDir).some(name => name.endsWith('.tmp')), 'Arquivo temporário não permanece após publicação');
    const invalidData = { ...data, sections: [{ ...data.sections[0], callouts: [] }] };
    assert(!validateVisualManifestOutput(invalidData, markdown, context).valid, 'Perda de realce no JSON é reportada');
  } finally {
    fs.rmSync(visualDir, { recursive: true, force: true });
  }
}

function assert(condition, testName) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${testName}`);
  } else {
    failed++;
    failures.push(testName);
    console.log(`  ❌ ${testName}`);
  }
}

function assertEqual(actual, expected, testName) {
  if (actual === expected) {
    passed++;
    console.log(`  ✅ ${testName}`);
  } else {
    failed++;
    const msg = `${testName} — esperado: "${expected}", obtido: "${actual}"`;
    failures.push(msg);
    console.log(`  ❌ ${msg}`);
  }
}

// Silencia logs durante os testes
const _log = console.log;
const _warn = console.warn;
function mute() { console.log = () => {}; console.warn = () => {}; }
function unmute() { console.log = _log; console.warn = _warn; }

// Fixture helper: cria um objeto data mínimo válido
function makeData(overrides = {}) {
  return {
    topic_id: 'dir-civil-lindb',
    topic_title: 'LINDB',
    discipline: 'Direito Civil',
    sections: [{
      section_id: 'dir-civil-lindb-sec-01',
      title: 'Vigência das Leis',
      content_markdown: 'Conteúdo.',
      flashcards: [{ question: 'Q?', answer: 'A.' }],
      mermaid_mindmap: 'mindmap\n  root',
      callouts: [{ type: 'info', title: 'T', text: 'X' }],
      mnemonics: [{ key: 'ABC', meaning: 'M', description: 'D' }],
    }],
    ...overrides,
  };
}

// ============================================================
// TESTES
// ============================================================

_log('\n🧪 ======= TESTES UNITÁRIOS — Módulo LEIAUT =======\n');

// ── Grupo 1: cleanMermaidCode ──────────────────────────────
_log('📦 Grupo 1: cleanMermaidCode');

assertEqual(cleanMermaidCode(null), '', 'Null → string vazia');
assertEqual(cleanMermaidCode(''), '', 'Vazio → string vazia');
assert(
  cleanMermaidCode('```mermaid\nmindmap\n  root\n```').includes('root_0["root"]'),
  'Remove cercas e converte mindmap para flowchart seguro'
);
assertEqual(
  cleanMermaidCode('flowchart TD\n  A[Origem] -->|segue para|\n  B[Destino]'),
  '',
  'Rejeita aresta Mermaid truncada antes do fim da linha'
);
assertEqual(
  cleanMermaidCode('root((Sem cabecalho))\n  Filho'),
  '',
  'Rejeita bloco sem cabecalho Mermaid reconhecido'
);
assert(
  cleanMermaidCode('graph TD\n  A[Tradicional (Clássico)]').includes('A["Tradicional (Clássico)"]'),
  'Escapa labels problemáticos em graph/flowchart'
);
(() => {
  const colorlessDiagram = cleanMermaidCode([
    'flowchart TD',
    '  A[Regra] -->|admite| B[Exceção]',
    '  classDef custom fill:#FF0000,stroke:#00FF00,color:#0000FF;',
    '  style A fill:#FFFF00;',
    '  linkStyle 0 stroke:#FF00FF;'
  ].join('\n'));

  assert(
    !/^\s*(?:classDef|style|linkStyle)\b/im.test(colorlessDiagram),
    'Remove cores e diretivas visuais do Mermaid'
  );
  assert(
    /class\s+A\s+readableRoot;/i.test(colorlessDiagram),
    'Preserva classificação semântica dos nós sem definir paleta'
  );
})();
assert(
  cleanMermaidCode('  ```mermaid\ngraph TD\n```  ').startsWith('graph TD'),
  'Trim de espaços exteriores'
);
assert(
  cleanMermaidCode('flowchart TD\n  A --> B\n\nflowchart TD\n  C --> D').includes('A --> B'),
  'Mantém apenas o primeiro diagrama permitido'
);
assert(
  cleanMermaidCode('stateDiagram-v2\n  [*] --> A\n\nmindmap\n  root').includes('root_0["root"]'),
  'Prefere diagrama permitido quando houver múltiplos'
);
assert(
  cleanMermaidCode('pie title Limites\n  "União" : 50').startsWith('flowchart TD'),
  'Converte pie para flowchart TD seguro'
);
assert(
  cleanMermaidCode('stateDiagram-v2\n  [*] --> LOA_Aprovada\n  LOA_Aprovada --> Fim : executa').startsWith('flowchart'),
  'Converte stateDiagram-v2 para flowchart TD'
);
assertEqual(
  cleanMermaidCode('graph LR\n  A[Item inicial com texto longo para quebrar lateralmente] --> B[Outro item muito grande que ficaria largo]'),
  '',
  'Omite diagrama lateral com rótulos excessivamente longos'
);
assertEqual(
  cleanMermaidCode([
    'flowchart TD',
    '  A[Mapa grande]',
    '  A --> B1[Item 1]',
    '  A --> B2[Item 2]',
    '  A --> B3[Item 3]',
    '  A --> B4[Item 4]',
    '  A --> B5[Item 5]',
    '  A --> B6[Item 6]',
    '  A --> B7[Item 7]',
    '  A --> B8[Item 8]',
    '  A --> B9[Item 9]',
    '  A --> B10[Item 10]',
    '  A --> B11[Item 11]',
    '  A --> B12[Item 12]',
    '  A --> B13[Item 13]',
    '  A --> B14[Item 14]',
    '  A --> B15[Item 15]'
  ].join('\n')),
  '',
  'Omite diagrama denso para permitir outro recurso didático'
);

// ── Grupo 2: topic_id ─────────────────────────────────────
_log('\n📦 Grupo 2: Normalização de topic_id');
(() => {
  mute();

  let d = makeData({ topic_id: 'dir_const_fundamentos' });
  validateAndNormalizeOutput(d);
  assertEqual(d.topic_id, 'dir-const-fundamentos', 'Underscores → hífens');

  d = makeData({ topic_id: 'DIR_CONST' });
  validateAndNormalizeOutput(d);
  assertEqual(d.topic_id, 'dir-const', 'Uppercase → lowercase');

  d = makeData({ topic_id: 'dir@const#123' });
  validateAndNormalizeOutput(d);
  assertEqual(d.topic_id, 'dirconst123', 'Caracteres especiais removidos');

  d = makeData({ topic_id: '' });
  validateAndNormalizeOutput(d);
  assertEqual(d.topic_id, 'topico-indefinido', 'Vazio → fallback');

  d = makeData();
  delete d.topic_id;
  validateAndNormalizeOutput(d);
  assertEqual(d.topic_id, 'topico-indefinido', 'Ausente → fallback');

  unmute();
})();

// ── Grupo 3: discipline ───────────────────────────────────
_log('\n📦 Grupo 3: Validação de discipline');
(() => {
  mute();

  let d = makeData({ discipline: 'direito constitucional' });
  validateAndNormalizeOutput(d);
  assertEqual(d.discipline, 'Direito Constitucional', 'Normaliza case-insensitive');

  d = makeData({ discipline: 'DIREITO CIVIL' });
  validateAndNormalizeOutput(d);
  assertEqual(d.discipline, 'Direito Civil', 'UPPERCASE normalizado');

  d = makeData({ discipline: 'Legislação Especial' });
  validateAndNormalizeOutput(d);
  assertEqual(d.discipline, 'Legislação Especial', 'Match exato preservado');

  d = makeData({ discipline: '' });
  validateAndNormalizeOutput(d);
  assertEqual(d.discipline, 'Geral', 'Vazio → "Geral"');

  d = makeData();
  delete d.discipline;
  validateAndNormalizeOutput(d);
  assertEqual(d.discipline, 'Geral', 'Ausente → "Geral"');

  d = makeData({ discipline: 'Física Quântica' });
  validateAndNormalizeOutput(d);
  assertEqual(d.discipline, 'Física Quântica', 'Disciplina desconhecida é preservada sem coerção jurídica');

  d = makeData({ discipline: 'contabilidade' });
  validateAndNormalizeOutput(d);
  assertEqual(d.discipline, 'Contabilidade', 'Disciplina não jurídica conhecida é normalizada');

  d = makeData({ discipline: '  Contabilidade   Geral  ' });
  validateAndNormalizeOutput(d);
  assertEqual(d.discipline, 'Contabilidade Geral', 'Disciplina não jurídica desconhecida é preservada sem coerção jurídica');

  d = makeData({ discipline: 'Orçamento Público' });
  validateAndNormalizeOutput(d);
  assertEqual(d.discipline, 'Administração Financeira e Orçamentária', 'Tema Orçamento Público é normalizado para a disciplina AFO');

  d = makeData({ discipline: 'Orçamento Público' });
  validateAndNormalizeOutput(d, 'Administração Financeira e Orçamentária - material 02.md');
  assertEqual(d.discipline, 'Administração Financeira e Orçamentária', 'Nome explícito do arquivo prevalece sobre classificação temática');

  unmute();
})();

// ── Grupo 4: section_id ──────────────────────────────────
_log('\n📦 Grupo 4: Normalização de section_id');
(() => {
  mute();

  // Divergência #3 + #4 do plano: underscore sem prefixo
  let d = makeData({
    topic_id: 'dir-constitucional',
    sections: [{ section_id: 'fundamentos_republica', title: 'T', content_markdown: 'C', flashcards: [], mermaid_mindmap: 'x' }]
  });
  validateAndNormalizeOutput(d);
  const sid = d.sections[0].section_id;
  assert(sid.startsWith('dir-constitucional-'), 'Prefixo topic_id adicionado');
  assert(!sid.includes('_'), 'Sem underscores');
  assert(sid.includes('-sec-'), 'Sufixo -sec-NN presente');

  // Já correto
  d = makeData({
    topic_id: 'dir-civil',
    sections: [{ section_id: 'dir-civil-sec-01', title: 'T', content_markdown: 'C', flashcards: [], mermaid_mindmap: 'x' }]
  });
  validateAndNormalizeOutput(d);
  assertEqual(d.sections[0].section_id, 'dir-civil-sec-01', 'ID correto permanece intacto');

  // Ausente
  d = makeData({
    topic_id: 'dir-penal',
    sections: [{ title: 'T', content_markdown: 'C', flashcards: [], mermaid_mindmap: 'x' }]
  });
  validateAndNormalizeOutput(d);
  assertEqual(d.sections[0].section_id, 'dir-penal-sec-01', 'Ausente → gerado automaticamente');

  // Múltiplas seções: numeração sequencial
  d = makeData({
    topic_id: 'dir-adm',
    sections: [
      { title: 'S1', content_markdown: 'C', flashcards: [], mermaid_mindmap: 'x' },
      { title: 'S2', content_markdown: 'C', flashcards: [], mermaid_mindmap: 'x' },
      { title: 'S3', content_markdown: 'C', flashcards: [], mermaid_mindmap: 'x' },
    ]
  });
  validateAndNormalizeOutput(d);
  assertEqual(d.sections[0].section_id, 'dir-adm-sec-01', 'Seção 1 → sec-01');
  assertEqual(d.sections[1].section_id, 'dir-adm-sec-02', 'Seção 2 → sec-02');
  assertEqual(d.sections[2].section_id, 'dir-adm-sec-03', 'Seção 3 → sec-03');

  unmute();
})();

// ── Grupo 5: callouts ────────────────────────────────────
_log('\n📦 Grupo 5: Validação de callouts');
(() => {
  mute();

  let d = makeData({
    sections: [{
      section_id: 'x-sec-01', title: 'T', content_markdown: 'C', flashcards: [], mermaid_mindmap: 'x',
      callouts: [
        { type: 'DANGER', title: 'T', text: 'X' },
        { type: 'alert', title: 'T', text: 'X' },
        { type: 'xpto', title: 'T', text: 'X' },
        { type: 'tip', title: 'T', text: 'X' },
        { type: 'warning', title: 'T', text: 'X' },
        { type: 'info', title: 'T', text: 'X' },
      ]
    }]
  });
  validateAndNormalizeOutput(d);
  const callouts = d.sections[0].callouts;
  assertEqual(callouts[0].type, 'warning', '"DANGER" → "warning"');
  assertEqual(callouts[1].type, 'warning', '"alert" → "warning"');
  assertEqual(callouts[2].type, 'info', 'Tipo inválido "xpto" → "info"');
  assertEqual(callouts[3].type, 'tip', '"tip" preservado');
  assertEqual(callouts[4].type, 'warning', '"warning" preservado');
  assertEqual(callouts[5].type, 'info', '"info" preservado');

  // Callout sem type
  d = makeData({
    sections: [{
      section_id: 'x-sec-01', title: 'T', content_markdown: 'C', flashcards: [], mermaid_mindmap: 'x',
      callouts: [{ title: 'T', text: 'X' }]
    }]
  });
  validateAndNormalizeOutput(d);
  assertEqual(d.sections[0].callouts[0].type, 'info', 'Callout sem type → "info"');

  d = makeData({
    sections: [{ section_id: 'x-sec-01', title: 'T', content_markdown: 'C', flashcards: [], mermaid_mindmap: 'x' }]
  });
  validateAndNormalizeOutput(d);
  assert(Array.isArray(d.sections[0].callouts), 'Callouts ausentes → array vazio');

  unmute();
})();

// ── Grupo 6: mnemonics transportados ─────────────────────
_log('\n📦 Grupo 6: Mnemônicos transportados da fonte');
(() => {
  mute();

  let d = makeData({
    sections: [{
      section_id: 'x-sec-01', title: 'T', content_markdown: 'C', flashcards: [], mermaid_mindmap: 'x',
      mnemonics: [{ key: 'SOCIDIVAPLU', meaning: 'Soberania...', description: 'Mnemônico revisado no PYGEM.' }]
    }]
  });
  validateAndNormalizeOutput(d);
  assertEqual(d.sections[0].mnemonics.length, 1, 'Mnemônico revisado na fonte → preservado');
  assertEqual(d.sections[0].mnemonics[0].key, 'SOCIDIVAPLU', 'Chave do mnemônico → preservada');

  d = makeData({
    sections: [{ section_id: 'x-sec-01', title: 'T', content_markdown: 'C', flashcards: [], mermaid_mindmap: 'x' }]
  });
  validateAndNormalizeOutput(d);
  assert(Array.isArray(d.sections[0].mnemonics), 'Mnemonics ausentes → array vazio');

  d = makeData({
    sections: [{
      section_id: 'x-sec-01', title: 'T', content_markdown: 'C', flashcards: [], mermaid_mindmap: 'x',
      mnemonics: [{ key: 'INCOMPLETO', meaning: 'Sem descrição' }]
    }]
  });
  validateAndNormalizeOutput(d);
  assertEqual(d.sections[0].mnemonics.length, 0, 'Mnemônico estruturalmente incompleto → descartado');

  d = makeData({
    sections: [{
      section_id: 'x-sec-01',
      title: 'Princípio do Não-Confisco',
      content_markdown: 'O princípio do não-confisco limita o poder de tributar.',
      callouts: [],
      mnemonics: [],
      flashcards: [],
      mermaid_mindmap: ''
    }]
  });
  validateAndNormalizeOutput(d);
  assertEqual(d.sections[0].title, 'Princípio do Não-Confisco', 'NÃO-CONFISCO com capitalização editorial → não bloqueado');

  unmute();
})();

// ── Grupo 7: flashcards ──────────────────────────────────
_log('\n📦 Grupo 7: Validação de flashcards');
(() => {
  mute();

  let d = makeData({
    sections: [{ section_id: 'x-sec-01', title: 'T', content_markdown: 'C', mermaid_mindmap: 'x' }]
  });
  validateAndNormalizeOutput(d);
  assert(Array.isArray(d.sections[0].flashcards), 'Flashcards ausentes → array vazio');
  assertEqual(d.sections[0].flashcards.length, 0, 'Array tem 0 itens');

  // Flashcard sem question/answer
  d = makeData({
    sections: [{
      section_id: 'x-sec-01', title: 'T', content_markdown: 'C', mermaid_mindmap: 'x',
      flashcards: [{}]
    }]
  });
  validateAndNormalizeOutput(d);
  assertEqual(d.sections[0].flashcards[0].question, 'Pergunta indefinida', 'Question vazia → fallback');
  assertEqual(d.sections[0].flashcards[0].answer, 'Resposta indefinida', 'Answer vazia → fallback');

  unmute();
})();

// ── Grupo 8: Edge cases ──────────────────────────────────
_log('\n📦 Grupo 8: Edge cases — dados nulos/inválidos');
(() => {
  mute();

  assertEqual(validateAndNormalizeOutput(null), null, 'null → null');
  assertEqual(validateAndNormalizeOutput(undefined), undefined, 'undefined → undefined');
  assertEqual(validateAndNormalizeOutput('string'), 'string', 'string → string');

  // Sections não é array
  let d = makeData({ sections: 'não é array' });
  validateAndNormalizeOutput(d);
  assert(Array.isArray(d.sections), 'sections string → convertida para array');
  assertEqual(d.sections.length, 0, 'Array vazio após conversão');

  // topic_title ausente
  d = makeData();
  delete d.topic_title;
  validateAndNormalizeOutput(d);
  assertEqual(d.topic_title, 'Título Indefinido', 'topic_title ausente → fallback');

  unmute();
})();

// ── Grupo 9: Parser determinístico sem IA ─────────────────────────
_log('\n📦 Grupo 9: Parser determinístico sem IA');
(() => {
  mute();

  const args = parseLeiautArgs(['--split-by-topic', 'contabilidade.md']);
  assertEqual(args.inputFile, 'contabilidade.md', 'parseLeiautArgs identifica arquivo');
  assert(args.noAi, '--split-by-topic implica noAi');
  assert(args.splitByTopic, '--split-by-topic ativado');

  const temporaryInputDir = fs.mkdtempSync(path.join(__dirname, '.tmp-leiaut-input-'));
  try {
    fs.writeFileSync(path.join(temporaryInputDir, '010-topico.md'), '# Tópico 10', 'utf-8');
    fs.writeFileSync(path.join(temporaryInputDir, '002-topico.MD'), '# Tópico 2', 'utf-8');
    fs.writeFileSync(path.join(temporaryInputDir, 'ignorar.txt'), 'não processar', 'utf-8');
    fs.mkdirSync(path.join(temporaryInputDir, 'subdiretorio'));
    fs.writeFileSync(path.join(temporaryInputDir, 'subdiretorio', '001-interno.md'), '# Interno', 'utf-8');

    const resolvedDirectory = resolveMarkdownInputPaths(temporaryInputDir);
    assertEqual(resolvedDirectory.inputType, 'directory', 'Entrada de diretório é reconhecida');
    assertEqual(resolvedDirectory.files.length, 2, 'Diretório inclui somente arquivos Markdown diretos');
    assertEqual(path.basename(resolvedDirectory.files[0]), '002-topico.MD', 'Arquivos do diretório usam ordem numérica');
    assertEqual(path.basename(resolvedDirectory.files[1]), '010-topico.md', 'Ordenação numérica preserva sequência crescente');

    const resolvedFile = resolveMarkdownInputPaths(resolvedDirectory.files[0]);
    assertEqual(resolvedFile.inputType, 'file', 'Entrada de arquivo único continua reconhecida');
    assertEqual(resolvedFile.files[0], resolvedDirectory.files[0], 'Arquivo único mantém o caminho original');
  } finally {
    fs.rmSync(temporaryInputDir, { recursive: true, force: true });
  }

  assertEqual(slugify('Balanço Patrimonial: Ativo & Passivo'), 'balanco-patrimonial-ativo-passivo', 'slugify remove acentos e símbolos');
  assertEqual(inferDiscipline('# Contabilidade Geral\n## Balanço Patrimonial', 'x.md'), 'Contabilidade', 'Inferência detecta Contabilidade pelo conteúdo');
  assertEqual(inferDiscipline('# Direito Civil\n## LINDB', 'afo.md'), 'Direito Civil', 'Conteúdo prevalece sobre nome de arquivo ambíguo');
  assertEqual(
    inferDiscipline(
      '# Conceitos e fontes do Direito Administrativo\n\nArt. 5º da Constituição Federal.',
      't_reescrito.md'
    ),
    'Direito Administrativo',
    'Disciplina explícita no primeiro título prevalece sobre referência constitucional no conteúdo'
  );
  assertEqual(
    inferDisciplineFromFileName('Administração Financeira e Orçamentária - material 02.md'),
    'Administração Financeira e Orçamentária',
    'Nome completo do arquivo identifica a disciplina canônica'
  );
  assertEqual(
    inferDiscipline('# Orçamento Público\n## Créditos adicionais', 'Administração Financeira e Orçamentária - parte 2.md'),
    'Administração Financeira e Orçamentária',
    'Nome explícito mantém a disciplina entre materiais temáticos diferentes'
  );

  const markdown = [
    '# Curso Exemplo',
    '',
    'Prefácio geral.',
    '',
    '## Primeiro Tema',
    'Texto introdutório.',
    '### Subtema A',
    'Conteúdo A.',
    '### Subtema B',
    'Conteúdo B.',
    '## Segundo Tema',
    'Conteúdo sem subtítulo.'
  ].join('\n');

  let outputs = buildDeterministicOutputs(markdown, 'curso-exemplo.md', { splitByTopic: false });
  assertEqual(outputs.length, 1, 'Sem split gera um JSON');
  assertEqual(outputs[0].data.sections.length, 3, 'Sem split preserva prefácio e usa ## como seções');

  outputs = buildDeterministicOutputs(markdown, 'curso-exemplo.md', { splitByTopic: true });
  assertEqual(outputs.length, 3, 'Split por tópico preserva prefácio e cria JSONs por ##');
  assertEqual(outputs[1].data.topic_title, 'Primeiro Tema', 'Primeiro ## vira tópico');
  assertEqual(outputs[1].data.sections.length, 3, 'Tópico com preface + dois ### vira três seções');
  assertEqual(outputs[2].data.sections[0].title, 'Segundo Tema', 'Tópico sem ### gera seção única');

  const immutableTitleMarkdown = [
    '@@@ LEI de Introdução às Normas: LINDB (TÍTULO ORIGINAL)',
    '## SUBTÍTULO REESCREVÍVEL',
    'Conteúdo.'
  ].join('\n');
  assertEqual(
    extractOriginalDocumentTitle(immutableTitleMarkdown),
    'LEI de Introdução às Normas: LINDB (TÍTULO ORIGINAL)',
    'Extrai literalmente o título original marcado por @@@'
  );
  assertEqual(
    getCanonicalTopicTitle(immutableTitleMarkdown, 'fallback'),
    'LEI de Introdução às Normas: LINDB (TÍTULO ORIGINAL)',
    'Título marcado prevalece sobre o primeiro cabeçalho'
  );
  const immutableOutputs = buildDeterministicOutputs(
    immutableTitleMarkdown,
    'material.md',
    { splitByTopic: false }
  );
  assertEqual(
    immutableOutputs[0].data.topic_title,
    'LEI de Introdução às Normas: LINDB (TÍTULO ORIGINAL)',
    'Modo determinístico não normaliza o título marcado'
  );
  assert(
    immutableOutputs[0].data.sections.some(section => section.title === 'Subtítulo reescrevível'),
    'Subtítulo continua sujeito à normalização editorial'
  );
  assertEqual(
    extractOriginalDocumentTitle('@@@\n## Seção do sumário\nConteúdo.'),
    null,
    'Marcador estrutural isolado não é confundido com título do material'
  );
  assertEqual(
    extractOriginalDocumentTitle('@@ Título ORIGINAL com dois arrobas\n### Subtítulo'),
    'Título ORIGINAL com dois arrobas',
    'Marcador de título com dois arrobas também é preservado'
  );
  assertEqual(
    extractOriginalDocumentTitle(
      '@@ CPC 23 – POLÍTICAS, ESTIMATIVAS CONTÁBEIS E RETIFICAÇÃO DE ERROS\nConteúdo.'
    ),
    'CPC 23 – Políticas, estimativas contábeis e retificação de erros',
    'Título marcado em caixa alta é normalizado para o contrato editorial do site'
  );
  assertEqual(
    getLevelTwoHeadingTitles('## CRITÉRIOS DE AVALIAÇÃO DO PASSIVO\nConteúdo descritivo.')[0],
    'Critérios de avaliação do passivo',
    'Cabeçalho em caixa alta não usa a própria linha como contexto de sigla'
  );

  const titleFixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'leiaut-title-'));
  const titleFixturePath = path.join(titleFixtureDirectory, 'material.md');
  try {
    fs.writeFileSync(titleFixturePath, immutableTitleMarkdown, 'utf8');
    const normalizedData = makeData({
      topic_title: 'Título alterado pela IA',
      sections: [{
        section_id: 'dir-civil-lindb-sec-01',
        title: 'SUBTÍTULO REESCREVÍVEL',
        content_markdown: 'Conteúdo.',
        callouts: [],
        mnemonics: [],
        flashcards: [],
        mermaid_mindmap: '',
      }],
    });
    validateAndNormalizeOutput(normalizedData, titleFixturePath);
    assertEqual(
      normalizedData.topic_title,
      'LEI de Introdução às Normas: LINDB (TÍTULO ORIGINAL)',
      'Validação restaura literalmente o título da fonte após resposta da IA'
    );
    assertEqual(
      normalizedData.sections[0].title,
      'Subtítulo reescrevível',
      'Validação continua normalizando título de seção'
    );
  } finally {
    fs.rmSync(titleFixtureDirectory, { recursive: true, force: true });
  }

  const blockPrompt = buildLeiautBlockPrompt('## Parte 2\nConteúdo.', {
    fileName: 'curso.md',
    topicTitle: 'Curso',
    discipline: 'Geral',
    topicId: 'curso',
    outline: '# Curso\n## Parte 1\n## Parte 2',
    blockIndex: 2,
    totalBlocks: 3,
  });
  assert(blockPrompt.includes('bloco 2 de 3'), 'Prompt fracionado identifica posição do bloco');
  assert(blockPrompt.includes('Transforme SOMENTE o conteúdo deste bloco'), 'Prompt impede repetição entre blocos');
  assert(!blockPrompt.includes('## Parte 1'), 'Prompt fracionado não expõe cabeçalhos de outros blocos');
  assert(blockPrompt.includes('Estrutura de cabeçalhos deste bloco'), 'Prompt identifica o outline como local ao bloco');

  const singleFilePrompt = buildLeiautBlockPrompt([
    '## Responsabilidade civil',
    'Texto.',
    '## Excludentes de responsabilidade (risco administrativo)',
    'Texto.',
    '## Excludentes de responsabilidade',
    'Texto.',
    '## Responsabilidade civil na CF/88',
    'Texto.',
    '## Ações indenizatórias: prazos prescricionais',
    'Texto.',
    '## Direito administrativo',
    'Texto.',
  ].join('\n'), {
    fileName: '007_direito-administrativo_reescrito.md',
    topicTitle: 'Responsabilidade civil do estado',
    discipline: 'Direito Administrativo',
    topicId: 'responsabilidade-civil-do-estado',
    blockIndex: 1,
    totalBlocks: 1,
  });
  assert(
    singleFilePrompt.includes('Retorne exatamente 6 seção(ões)')
      && singleFilePrompt.includes('Ações indenizatórias: prazos prescricionais')
      && singleFilePrompt.includes('Direito administrativo'),
    'Prompt de arquivo completo também fixa quantidade, ordem e títulos ## exatos'
  );

  const merged = mergeLeiautBlockData([
    { sections: [makeData().sections[0]] },
    { sections: [{ ...makeData().sections[0], title: 'Segunda seção' }] },
  ], {
    topicId: 'curso',
    topicTitle: 'Curso',
    discipline: 'Geral',
  });
  assertEqual(merged.sections.length, 2, 'Consolidação preserva todas as seções e sua ordem');
  assertEqual(merged.topic_id, 'curso', 'Consolidação usa metadados canônicos do arquivo completo');
  assertEqual(merged.sections[0].section_id, 'curso-sec-01', 'Consolidação renumera a primeira seção');
  assertEqual(merged.sections[1].section_id, 'curso-sec-02', 'Consolidação elimina IDs repetidos entre blocos');

  unmute();
})();

// ── Grupo 10: Diagnóstico pós-geração sem mutação ─────────
_log('\n📦 Grupo 10: Diagnóstico pós-geração sem mutação');
(() => {
  const data = {
    topic_id: 'direito-tributario',
    topic_title: 'Direito Tributário',
    discipline: 'Direito Tributário',
    sections: [{
      section_id: 'direito-tributario-sec-01',
      title: 'Princípio do Não-Confisco',
      content_markdown: 'Art. 150 da Constituição Federal: é vedado utilizar tributo com efeito de confisco.',
      callouts: [],
      mnemonics: [],
      flashcards: [{
        question: '[LETRA DA LEI] É vedado utilizar tributo com efeito de confisco.',
        answer: 'Gabarito: CERTO. Justificativa: A Constituição contém essa vedação.',
      }],
      mermaid_mindmap: '',
    }],
  };
  const before = JSON.stringify(data);
  const diagnostics = collectPostGenerationDiagnostics(data);
  const formatted = formatDiagnosticsLog(diagnostics, {
    generatedAt: '2026-07-18T00:00:00.000Z',
    outputPath: 'C:\\leiaut\\teste_processado.json',
  });

  assertEqual(JSON.stringify(data), before, 'Diagnóstico não modifica o JSON gerado');
  assert(
    diagnostics.some(item => item.code === 'FLASHCARD_QUALITY'),
    'Flashcard editorialmente inválido é registrado no diagnóstico'
  );
  assert(
    diagnostics.some(item => item.code === 'MERMAID_EMPTY' && item.level === 'INFO'),
    'Mermaid opcional ausente é registrado como informação'
  );
  assert(
    formatted.text.includes('JSON foi gravado antes deste diagnóstico'),
    'Log documenta que o arquivo de saída foi preservado antes do diagnóstico'
  );
})();

// ── Grupo 11: Validação do JSON previamente gerado ────────
_log('\n📦 Grupo 11: Validação do JSON de saída existente');
(() => {
  const fs = require('fs');
  const path = require('path');
  const jsonPath = path.join(__dirname, 'direito_constitucional_processado.json');
  
  if (!fs.existsSync(jsonPath)) {
    _log('  ⏭️  Arquivo direito_constitucional_processado.json não encontrado, pulando.');
    return;
  }
  
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  
  assert(!!data.discipline, 'JSON gerado possui campo discipline');
  assert(data.discipline !== 'Geral', 'Discipline não é "Geral" (inferida corretamente)');
  assertEqual(data.discipline, 'Direito Constitucional', 'Discipline = "Direito Constitucional"');
  
  assert(!!data.topic_id, 'JSON gerado possui topic_id');
  assert(!data.topic_id.includes('_'), 'topic_id não contém underscores');
  
  data.sections.forEach((sec, i) => {
    assert(sec.section_id.startsWith(data.topic_id), `Seção ${i+1}: section_id prefixado com topic_id`);
    assert(sec.section_id.includes('-sec-'), `Seção ${i+1}: section_id contém -sec-NN`);
    assert(!sec.section_id.includes('_'), `Seção ${i+1}: section_id sem underscores`);
    
    if (sec.mnemonics) {
      sec.mnemonics.forEach((m, j) => {
        assert(!!m.description, `Seção ${i+1}, Mnemônico ${j+1}: possui description`);
      });
    }
    
    if (sec.callouts) {
      sec.callouts.forEach((c, j) => {
        assert(['warning', 'info', 'tip'].includes(c.type), `Seção ${i+1}, Callout ${j+1}: tipo válido (${c.type})`);
      });
    }
  });
})();

// ── Grupo 12: Artefatos de transporte em Markdown ─────────
_log('\n📦 Grupo 12: Normalização conservadora de \\n literal');
(() => {
  assertEqual(
    normalizeMarkdownTransportNewlines('Introdução.\\n\\n### Regras\\n* Item 1\\n* Item 2'),
    'Introdução.\n\n### Regras\n* Item 1\n* Item 2',
    '\\n literal com estrutura Markdown é convertido em quebra real'
  );
  assertEqual(
    normalizeMarkdownTransportNewlines('Em JavaScript, \\n representa uma quebra de linha.'),
    'Em JavaScript, \\n representa uma quebra de linha.',
    '\\n isolado e potencialmente intencional é preservado'
  );
  const transported = {
    sections: [{
      content_markdown: 'Texto.\\n\\n### Regras\\n* Item',
      mermaid_mindmap: 'flowchart TD\\nA --> B'
    }]
  };
  mute();
  normalizeContentTransportArtifacts(transported, 'teste');
  unmute();
  assertEqual(
    transported.sections[0].content_markdown,
    'Texto.\n\n### Regras\n* Item',
    'normalização atua em content_markdown'
  );
  assertEqual(
    transported.sections[0].mermaid_mindmap,
    'flowchart TD\nA --> B',
    'normalização converte \\n em Mermaid reconhecido'
  );
  assertEqual(
    normalizeMermaidTransportNewlines('Texto explicativo \\n sem tipo Mermaid'),
    'Texto explicativo \\n sem tipo Mermaid',
    'texto sem tipo Mermaid é preservado'
  );
})();

// ── Grupo 13: padrão editorial e estrutural ────────────────
_log('\n📦 Grupo 13: Padrão editorial e estrutural');
(() => {
  assertEqual(
    normalizeStudyTitle('AUDITORIA INTERNA (NBC TI 01)'),
    'Auditoria interna (NBC TI 01)',
    'Título em caixa alta é convertido para capitalização editorial'
  );
  assertEqual(
    normalizeStudyTitle('CIDE COMBUSTÍVEIS'),
    'CIDE Combustíveis',
    'Sigla inicial é preservada e primeira palavra descritiva recebe maiúscula'
  );
  assertEqual(
    normalizeStudyTitle('IPVA', 'O IPVA é um imposto estadual.'),
    'IPVA',
    'Sigla não cadastrada é preservada quando confirmada pelo conteúdo'
  );
  assertEqual(
    normalizeStudyTitle('ERRO', 'O erro é uma distorção não intencional.'),
    'Erro',
    'Palavra comum em caixa alta não é confundida com sigla'
  );
  assertEqual(
    normalizeStudyTitle('PRINCÍPIOS DE CONTROLE INTERNO (DOUTINA)'),
    'Princípios de controle interno (doutrina)',
    'Erro DOUTINA é corrigido durante a normalização do título'
  );
  assertEqual(
    removeOrphanMarkdownHeadings('Texto.\n\n### Fluxo\n\n### Etapas\n\n#### Atividade\nConteúdo.'),
    'Texto.\n\n### Etapas\n\n#### Atividade\nConteúdo.',
    'Subtítulo sem conteúdo é removido e agrupador com filho é preservado'
  );

  const invalidInput = validateMarkdownInput(`## Tabela\n| A | ${' '.repeat(1001)}B |`);
  assert(
    !invalidInput.valid && invalidInput.issues.some(issue => issue.includes('sequência patológica')),
    'Entrada com sequência patológica de espaços é rejeitada antes da IA'
  );
  const emptySectionInput = validateMarkdownInput(
    '@@@\n## Administração pública\n\n@@@\n## Disposições gerais\n\nConteúdo.'
  );
  assert(
    !emptySectionInput.valid
      && emptySectionInput.issues.some(issue => issue.includes('sem conteúdo')),
    'Entrada com seção ## vazia é rejeitada antes da IA'
  );
  assert(
    validateMarkdownInput('## Administração pública\n\n### Princípios\n\nConteúdo.').valid,
    'Seção ## com conteúdo subordinado em ### permanece válida'
  );

  let emptyGeneratedSectionRejected = false;
  try {
    assertImportableSections({
      sections: [{
        title: 'Disposições gerais',
        content_markdown: '',
        callouts: [],
        mnemonics: [],
        flashcards: [],
        mermaid_mindmap: '',
      }],
    });
  } catch (error) {
    emptyGeneratedSectionRejected = error.code === 'LEIAUT_SECTION_EMPTY';
  }
  assert(
    emptyGeneratedSectionRejected,
    'Saída com seção sem conteúdo nem recurso é bloqueada antes da gravação'
  );
  assert(
    assertImportableSections({
      sections: [{
        title: 'Seção com recurso',
        content_markdown: '',
        callouts: [],
        mnemonics: [],
        flashcards: [{ question: 'Pergunta', answer: 'Resposta' }],
        mermaid_mindmap: '',
      }],
    }).sections.length === 1,
    'Seção sem Markdown mas com recurso didático continua importável'
  );

  assertEqual(
    normalizeInlineTopicMarkers(
      '@@@ ## Empresa e Empresário\nTexto.\n@@@\n## Registro\n@@@ ### Subtítulo'
    ),
    '@@@\n## Empresa e Empresário\nTexto.\n@@@\n## Registro\n@@@ ### Subtítulo',
    'Marcador PYGEM na mesma linha do título ## é normalizado sem alterar outros marcadores'
  );

  assertEqual(
    removePygemRecoveryMarkers([
      '@@@ Poderes e deveres da administração pública',
      'Texto preservado.',
      '## Recuperação de bloco',
      'Mais conteúdo preservado.',
      '@@@ Recuperacao de bloco',
      'Parágrafo sobre recuperação de bloco permanece.',
    ].join('\n')),
    [
      '@@@ Poderes e deveres da administração pública',
      'Texto preservado.',
      'Mais conteúdo preservado.',
      'Parágrafo sobre recuperação de bloco permanece.',
    ].join('\n'),
    'Somente marcadores técnicos exatos de recuperação são removidos'
  );

  const source = '## PRIMEIRO TEMA\nTexto.\n### Filho\nConteúdo.\n## SEGUNDO TEMA\nTexto.';
  const validStructure = {
    sections: [
      { title: 'Primeiro tema' },
      { title: 'Segundo tema' },
    ],
  };
  assert(
    assertSectionStructureMatchesSource(validStructure, source) === validStructure,
    'Estrutura com uma seção por ## é aceita'
  );

  let structureRejected = false;
  try {
    assertSectionStructureMatchesSource({
      sections: [
        { title: 'Primeiro tema' },
        { title: 'Filho' },
        { title: 'Segundo tema' },
      ],
    }, source);
  } catch (error) {
    structureRejected = error.code === 'LEIAUT_SECTION_STRUCTURE_INVALID';
  }
  assert(structureRejected, 'Subtítulo ### promovido a seção JSON é rejeitado');

  const qualifiedSource = [
    '## Proibições ao servidor público (continuação)',
    'Texto.',
    '## Apuração de responsabilidade (PAD e sindicância)',
    'Texto.',
  ].join('\n');
  const qualifiedData = {
    sections: [
      { title: 'Proibições ao servidor público' },
      { title: 'Apuração de responsabilidade' },
    ],
  };
  canonicalizeSectionTitlesFromSource(qualifiedData, qualifiedSource);
  assertEqual(
    qualifiedData.sections[0].title,
    'Proibições ao servidor público (continuação)',
    'Qualificador parentético omitido pela IA é restaurado da fonte'
  );
  assert(
    assertSectionStructureMatchesSource(qualifiedData, qualifiedSource) === qualifiedData,
    'Estrutura passa após restauração determinística dos qualificadores'
  );

  const legalCitationSource = [
    '## Produção de provas',
    'Texto.',
    '## Desistência e outros casos de extinção (art. 51 e 52)',
    'Texto.',
    '## Preferência',
    'Texto.',
  ].join('\n');
  const legalCitationData = {
    sections: [
      { title: 'Produção de provas' },
      { title: 'Desistência e outros casos de extinção (arts. 51 e 52)' },
      { title: 'Preferência' },
    ],
  };
  canonicalizeSectionTitlesFromSource(legalCitationData, legalCitationSource);
  assertEqual(
    legalCitationData.sections[1].title,
    'Desistência e outros casos de extinção (art. 51 e 52)',
    'Variação art./arts. é restaurada literalmente a partir da fonte'
  );
  assert(
    assertSectionStructureMatchesSource(legalCitationData, legalCitationSource) === legalCitationData,
    'Estrutura passa após normalização controlada da abreviação de artigo'
  );

  const wrongLegalCitationData = {
    sections: [
      { title: 'Produção de provas' },
      { title: 'Desistência e outros casos de extinção (arts. 51 e 53)' },
      { title: 'Preferência' },
    ],
  };
  canonicalizeSectionTitlesFromSource(wrongLegalCitationData, legalCitationSource);
  let wrongLegalCitationRejected = false;
  try {
    assertSectionStructureMatchesSource(wrongLegalCitationData, legalCitationSource);
  } catch (error) {
    wrongLegalCitationRejected = error.code === 'LEIAUT_SECTION_STRUCTURE_INVALID';
  }
  assert(wrongLegalCitationRejected, 'Número de artigo divergente continua sendo rejeitado');

  const incompatibleData = {
    sections: [
      { title: 'Tema diferente' },
      { title: 'Apuração de responsabilidade' },
    ],
  };
  canonicalizeSectionTitlesFromSource(incompatibleData, qualifiedSource);
  let incompatibleStructureRejected = false;
  try {
    assertSectionStructureMatchesSource(incompatibleData, qualifiedSource);
  } catch (error) {
    incompatibleStructureRejected = error.code === 'LEIAUT_SECTION_STRUCTURE_INVALID';
  }
  assert(incompatibleStructureRejected, 'Título realmente incompatível continua sendo rejeitado');

  const sourceBackedRecovery = {
    sections: [{
      title: 'Disposições preliminares',
      content_markdown: '',
      callouts: [],
      mnemonics: [],
      flashcards: [],
      mermaid_mindmap: '',
    }],
  };
  recoverEmptySectionsFromSource(sourceBackedRecovery, [
    '### Disposições preliminares',
    '',
    '#### Âmbito de aplicação',
    '',
    '> **FLASHCARD**',
    '>',
    '> Conteúdo literal da fonte.',
  ].join('\n'));
  assert(
    sourceBackedRecovery.sections[0].content_markdown.includes('Conteúdo literal da fonte.'),
    'Seção vazia com cabeçalho único recupera somente o corpo Markdown literal da fonte'
  );
  assert(
    assertImportableSections(sourceBackedRecovery) === sourceBackedRecovery,
    'Seção recuperada da fonte volta a ser importável'
  );

  const ambiguousRecovery = {
    sections: [{
      title: 'Título repetido',
      content_markdown: '',
      callouts: [],
      mnemonics: [],
      flashcards: [],
      mermaid_mindmap: '',
    }],
  };
  recoverEmptySectionsFromSource(
    ambiguousRecovery,
    '### Título repetido\nPrimeiro.\n### Título repetido\nSegundo.'
  );
  assertEqual(
    ambiguousRecovery.sections[0].content_markdown,
    '',
    'Cabeçalho duplicado não é usado para recuperação ambígua'
  );

  const structuralBlocks = splitContentIntoBlocks([
    '## Tema um',
    'Texto de tamanho suficiente.',
    '### Subtema',
    'Conteúdo subordinado.',
    '## Tema dois',
    'Outro conteúdo.',
  ].join('\n'), 25);
  assertEqual(structuralBlocks.length, 2, 'Divisão em blocos ocorre somente entre seções ##');
  assert(
    structuralBlocks[0].includes('### Subtema'),
    'Subtítulo ### permanece no mesmo bloco do pai ##'
  );

  const blocksWithPreface = splitContentIntoBlocks([
    '@@@ Definições',
    '### Conceito',
    'Conteúdo introdutório.',
    '## Primeiro tema',
    'Texto do primeiro tema.',
    '## Segundo tema',
    'Texto do segundo tema.',
  ].join('\n'), 25, { maxStructuralUnitTokens: 80 });
  assert(
    blocksWithPreface[0].includes('@@@ Definições') && blocksWithPreface[0].includes('## Primeiro tema'),
    'Prefácio é anexado à primeira seção ## em vez de formar bloco sem seção'
  );
  assert(
    blocksWithPreface.every(block => /^##(?!#)\s+\S/m.test(block)),
    'Arquivo com seções ## não gera bloco fracionado sem seção principal'
  );

  let oversizedSectionRejected = false;
  try {
    splitContentIntoBlocks(`## Tema único\n${'conteúdo '.repeat(100)}`, 10);
  } catch (error) {
    oversizedSectionRejected = error.code === 'LEIAUT_SECTION_TOO_LARGE';
  }
  assert(oversizedSectionRejected, 'Seção ## maior que o teto não é dividida silenciosamente');

  const isolatedOversizedSection = `## Tema grande\n${'conteúdo '.repeat(20).trim()}`;
  const isolatedStructuralBlocks = splitContentIntoBlocks(
    `${isolatedOversizedSection}\n\n## Tema pequeno\nTexto curto.`,
    20,
    { maxStructuralUnitTokens: 80 }
  );
  assertEqual(isolatedStructuralBlocks.length, 2, 'Seção moderadamente grande é mantida como bloco isolado');
  assertEqual(
    isolatedStructuralBlocks[0],
    isolatedOversizedSection,
    'Seção isolada não é cortada nem misturada com a seção seguinte'
  );
})();

// ── Grupo 14: Resiliência de chamadas Vertex AI ───────────────────
_log('\n📦 Grupo 14: Resiliência de chamadas Vertex AI');
(() => {
  assertEqual(getVertexErrorStatus({ status: 429 }), 429, 'Status numérico 429 é reconhecido');
  assertEqual(
    getVertexErrorStatus({ message: '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}' }),
    429,
    'Erro RESOURCE_EXHAUSTED serializado é reconhecido'
  );
  assert(isRetryableVertexError({ status: 500 }), 'Erro 500 é tratado como transitório');
  assert(isRetryableVertexError({ status: 503 }), 'Erro 503 é tratado como transitório');
  assert(!isRetryableVertexError({ status: 400 }), 'Erro 400 não é repetido');
  assert(!isRetryableVertexError({ name: 'AbortError' }), 'Abort/timeout não é repetido automaticamente');
  assert(
    shouldRetryVertexFailure(
      { code: 'LEIAUT_MAX_TOKENS' },
      {
        transientFailureCount: 2,
        maxTransientRetries: 2,
        maxTokenFailureCount: 3,
        maxTokenRetries: 3,
      }
    ),
    'Retry de MAX_TOKENS permanece disponível após esgotar retries transitórios'
  );
  assert(
    !shouldRetryVertexFailure(
      { status: 503 },
      {
        transientFailureCount: 3,
        maxTransientRetries: 2,
        maxTokenFailureCount: 0,
        maxTokenRetries: 3,
      }
    ),
    'Retry transitório respeita seu próprio limite independente'
  );

  assertEqual(
    calculateRetryDelayMs(1, {
      baseDelayMs: 1000,
      maxDelayMs: 10000,
      randomValue: 0.5,
    }),
    1000,
    'Primeiro retry usa o atraso-base com jitter neutro'
  );
  assertEqual(
    calculateRetryDelayMs(2, {
      baseDelayMs: 1000,
      maxDelayMs: 10000,
      randomValue: 0.5,
    }),
    2000,
    'Segundo retry aplica backoff exponencial'
  );
  assertEqual(
    calculateRetryDelayMs(1, {
      baseDelayMs: 1000,
      maxDelayMs: 10000,
      retryAfterMs: 5000,
      randomValue: 0.5,
    }),
    5000,
    'Retry-After maior que o backoff é respeitado'
  );
  assertEqual(
    getRetryAfterMs({ headers: { 'retry-after': '7' } }),
    7000,
    'Retry-After em segundos é convertido para milissegundos'
  );
  const outputBudgetOptions = {
    minOutputTokens: 100,
    maxOutputTokens: 1000,
    outputTokenMultiplier: 1,
    outputTokenRetryMultiplier: 2,
    maxOutputTokenRetryMultiplier: 4,
  };
  assertEqual(
    calculateFlexibleOutputTokens('trecho curto', 0, outputBudgetOptions),
    100,
    'Orçamento de saída respeita o piso configurado'
  );
  assertEqual(
    calculateFlexibleOutputTokens('trecho curto', 1, outputBudgetOptions),
    200,
    'Primeiro MAX_TOKENS duplica o orçamento-base'
  );
  assertEqual(
    calculateFlexibleOutputTokens('trecho curto', 2, outputBudgetOptions),
    400,
    'Segundo MAX_TOKENS amplia novamente sem ignorar o piso'
  );
  assertEqual(
    calculateFlexibleOutputTokens('trecho curto', 3, {
      ...outputBudgetOptions,
      maxOutputTokenRetryMultiplier: 8,
    }),
    800,
    'Terceiro MAX_TOKENS permite crescimento controlado até 8 vezes'
  );
  assertEqual(
    calculateFlexibleOutputTokens('conteúdo '.repeat(2000), 2, outputBudgetOptions),
    1000,
    'Orçamento flexível nunca ultrapassa o teto configurado'
  );
  assertEqual(
    getVertexFinishReason({ candidates: [{ finishReason: 'MAX_TOKENS' }] }),
    'MAX_TOKENS',
    'Motivo MAX_TOKENS é detectado antes do parse do JSON'
  );
  assertEqual(
    getVertexTokenUsage({
      usageMetadata: {
        promptTokenCount: 120,
        candidatesTokenCount: 4096,
        thoughtsTokenCount: 3000,
      },
    }).thoughtTokens,
    3000,
    'Uso de raciocínio informado pelo Vertex é preservado para diagnóstico'
  );
})();

// ============================================================
// Resumo
// ============================================================
_log(`\n${'='.repeat(60)}`);
_log(`📊 Resultado: ${passed} passaram, ${failed} falharam de ${passed + failed} testes`);
if (failures.length > 0) {
  _log('\n❌ Falhas:');
  failures.forEach(f => _log(`   - ${f}`));
}
_log(`${'='.repeat(60)}\n`);

process.exit(failed > 0 ? 1 : 0);
