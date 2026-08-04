const assert = require('assert');
const path = require('path');
const {
  cleanMermaidCode,
  getLeiautOutputDirectory,
  LEIAUT_OUTPUT_ROOT,
  systemInstruction,
} = require('./src/app-leiaut');
const {
  EnrichmentQualityError,
  extractMermaidGraph,
  validateEnrichmentQuality,
} = require('./src/leiaut/enrichment-quality');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, callback) {
  try {
    callback();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    console.log(`  ❌ ${name}: ${error.message}`);
  }
}

function makeUnit() {
  return {
    sections: [{
      section_id: 'topico-sec-01',
      title: 'Teoria das Contas',
      content_markdown: 'Patrimonialista: Ativo, Passivo, PL, Receitas e Despesas.',
    }],
  };
}

function makeResponse(overrides = {}) {
  return {
    sections: [{
      section_id: 'topico-sec-01',
      callouts: [],
      mnemonics: [],
      flashcards: [],
      mermaid_mindmap: 'flowchart TD\n  A[Teoria]\n  B[Patrimonialista]\n  C[Contas]\n  A -->|classifica por| B\n  B -->|possui| C',
      ...overrides,
    }],
  };
}

console.log('\n🧪 ===== TESTES — Qualidade do enriquecimento LEIAUT =====\n');

test('saída usa a pasta originária abaixo da raiz fixa do LEIAUT', () => {
  assert.strictEqual(
    getLeiautOutputDirectory('C:\\materiais\\Contabilidade Geral\\001.md'),
    path.join(LEIAUT_OUTPUT_ROOT, 'Contabilidade Geral')
  );
});

test('prompt limita flashcards a questões de concurso ou letra da lei', () => {
  assert.match(systemInstruction, /crie de 3 a 5 flashcards por seção/u);
  assert.match(systemInstruction, /questão de concurso identificável/u);
  assert.match(systemInstruction, /redação legal expressa/u);
  assert.match(systemInstruction, /retorne 'flashcards': \[\]/u);
});

test('mnemônico já analisado na fonte não é bloqueado pelo LEIAUT', () => {
  const response = makeResponse({ mnemonics: [{
    key: 'APPL',
    meaning: 'Ativo, Passivo, PL; Receitas e Despesas.',
    description: 'Mnemônico revisado na etapa de escrita.',
  }] });
  assert.doesNotThrow(() => validateEnrichmentQuality(makeUnit(), response));
});

test('callout com finalidade externa à fonte é bloqueado', () => {
  const response = makeResponse({
    callouts: [{
      type: 'info',
      title: 'Finalidade',
      text: 'A classificação é essencial para garantir a fidedignidade das informações financeiras.',
    }],
  });
  assert.throws(
    () => validateEnrichmentQuality(makeUnit(), response),
    error => error instanceof EnrichmentQualityError
      && error.details.some(detail => detail.includes('nao ancorados'))
  );
});

test('intensificador ausente da fonte é bloqueado em callout', () => {
  const response = makeResponse({
    callouts: [{ type: 'info', title: 'Efeito', text: 'As contas sempre incluem Ativo e Passivo.' }],
  });
  assert.throws(
    () => validateEnrichmentQuality(makeUnit(), response),
    error => error instanceof EnrichmentQualityError
      && error.details.some(detail => detail.includes('intensificadores'))
  );
});

test('sequência externa é bloqueada em resposta de flashcard', () => {
  const response = makeResponse({
    flashcards: [{
      question: 'O que é a classificação?',
      answer: 'É uma ferramenta estratégica para decisões financeiras eficientes.',
    }],
  });
  assert.throws(
    () => validateEnrichmentQuality(makeUnit(), response),
    error => error instanceof EnrichmentQualityError
      && error.details.some(detail => detail.includes('sequencia editorial'))
  );
});

test('mapa com nó desconectado é bloqueado', () => {
  const response = makeResponse({
    mermaid_mindmap: 'flowchart TD\n  A[Raiz]\n  B[Ligado]\n  C[Solto]\n  A -->|inclui| B',
  });
  assert.throws(
    () => validateEnrichmentQuality(makeUnit(), response),
    error => error instanceof EnrichmentQualityError
      && error.details.some(detail => detail.includes('sem relacao'))
  );
});

test('mapa com aresta sem rotulo semantico é bloqueado', () => {
  const response = makeResponse({
    mermaid_mindmap: 'flowchart TD\n  A[Raiz]\n  B[Ligado]\n  A --> B',
  });
  assert.throws(
    () => validateEnrichmentQuality(makeUnit(), response),
    error => error instanceof EnrichmentQualityError
      && error.details.some(detail => detail.includes('rotulo semantico'))
  );
});

test('mapa com agrupador sintetico generico é bloqueado', () => {
  const response = makeResponse({
    mermaid_mindmap: 'flowchart TD\n  A[Teoria]\n  G[Grupo temático 1]\n  B[Conta]\n  A -->|organiza| G\n  G -->|inclui| B',
  });
  assert.throws(
    () => validateEnrichmentQuality(makeUnit(), response),
    error => error instanceof EnrichmentQualityError
      && error.details.some(detail => detail.includes('agrupadores sinteticos'))
  );
});

test('mapa pode ser omitido quando outro recurso didatico for mais legivel', () => {
  assert.doesNotThrow(() => validateEnrichmentQuality(
    makeUnit(),
    makeResponse({ mermaid_mindmap: '' })
  ));
});

test('mapa lateral é bloqueado', () => {
  const response = makeResponse({
    mermaid_mindmap: 'flowchart LR\n  A[Raiz]\n  B[Ligado]\n  A -->|inclui| B',
  });
  assert.throws(
    () => validateEnrichmentQuality(makeUnit(), response),
    error => error instanceof EnrichmentQualityError
      && error.details.some(detail => detail.includes('TD ou TB'))
  );
});

test('mapa com mais de seis nos é bloqueado', () => {
  const response = makeResponse({
    mermaid_mindmap: [
      'flowchart TD',
      '  A[Raiz]', '  B[Um]', '  C[Dois]', '  D[Tres]',
      '  E[Quatro]', '  F[Cinco]', '  G[Seis]',
      '  A -->|inclui| B', '  B -->|segue| C', '  C -->|segue| D',
      '  D -->|segue| E', '  E -->|segue| F', '  F -->|segue| G',
    ].join('\n'),
  });
  assert.throws(
    () => validateEnrichmentQuality(makeUnit(), response),
    error => error instanceof EnrichmentQualityError
      && error.details.some(detail => detail.includes('limite e 6'))
  );
});

test('mapa com mais de tres filhos diretos é bloqueado', () => {
  const response = makeResponse({
    mermaid_mindmap: [
      'flowchart TD',
      '  A[Raiz]', '  B[Um]', '  C[Dois]', '  D[Tres]', '  E[Quatro]',
      '  A -->|inclui| B', '  A -->|inclui| C',
      '  A -->|inclui| D', '  A -->|inclui| E',
    ].join('\n'),
  });
  assert.throws(
    () => validateEnrichmentQuality(makeUnit(), response),
    error => error instanceof EnrichmentQualityError
      && error.details.some(detail => detail.includes('limite e 3'))
  );
});

test('extrator reconhece grafo integralmente conectado', () => {
  const graph = extractMermaidGraph('flowchart TD\n  A[Raiz]\n  B[Um]\n  C[Dois]\n  A -->|inclui| B\n  A -->|inclui| C');
  assert.deepStrictEqual([...graph.nodes], ['A', 'B', 'C']);
  assert.deepStrictEqual(graph.edges, [['A', 'B', 'inclui'], ['A', 'C', 'inclui']]);
});

test('limpeza omite mapa denso para permitir outro recurso didatico', () => {
  const dense = [
    'flowchart LR',
    '  A[Teoria das Contas] -->|adota| B[Patrimonialista]',
    '  A -->|adota| C[Materialista]',
    '  A -->|adota| D[Personalista]',
    '  B -->|classifica| E[Ativo]',
    '  B -->|classifica| F[Passivo]',
    '  B -->|classifica| G[PL]',
    '  C -->|classifica| H[Bens]',
    '  C -->|classifica| I[Direitos]',
    '  C -->|classifica| J[Obrigações]',
    '  D -->|identifica| K[Proprietários]',
  ].join('\n');
  const cleaned = cleanMermaidCode(dense, { title: 'Teoria das Contas' });
  assert.strictEqual(cleaned, '');
});

console.log(`\n${'='.repeat(72)}`);
console.log(`📊 Resultado: ${passed} passaram, ${failed} falharam de ${passed + failed} testes`);
if (failures.length > 0) {
  failures.forEach(({ name, error }) => console.log(`   - ${name}: ${error.stack || error.message}`));
}
console.log(`${'='.repeat(72)}\n`);

process.exitCode = failed > 0 ? 1 : 0;
