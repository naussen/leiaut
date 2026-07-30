const CONNECTOR_WORDS = new Set([
  'a', 'as', 'com', 'da', 'das', 'de', 'do', 'dos', 'e', 'em', 'o', 'os', 'para', 'por',
]);

const HIGH_RISK_UNANCHORED_WORDS = new Set([
  'APENAS', 'ASSEGURA', 'ASSEGURAR', 'CRUCIAL', 'ESSENCIAL', 'EXCLUSIVAMENTE',
  'GARANTE', 'GARANTIR', 'NECESSARIAMENTE', 'NUNCA', 'OBRIGATORIAMENTE', 'SEMPRE', 'SOMENTE',
]);

const { validateSectionFlashcards } = require('./flashcard-quality');

const QUALITY_RULES_VERSION = 'enrichment-quality-v8';
const MERMAID_MAX_NODES = 6;
const MERMAID_MAX_EDGES = 6;
const MERMAID_MAX_FANOUT = 3;

class EnrichmentQualityError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'EnrichmentQualityError';
    this.details = details;
  }
}

function normalizeWord(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase();
}

function tokenize(value) {
  return String(value || '').match(/[\p{L}\p{N}]+/gu) || [];
}

function significantTokens(value) {
  return tokenize(value).filter(token => !CONNECTOR_WORDS.has(
    token.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  ));
}

function lexicalRoot(value) {
  const normalized = normalizeWord(value);
  if (normalized.length > 5 && normalized.endsWith('ES')) return normalized.slice(0, -2);
  if (normalized.length > 4 && normalized.endsWith('S')) return normalized.slice(0, -1);
  return normalized;
}

function findUnanchoredRuns(value, sourceMarkdown, minimumLength = 4) {
  const sourceRoots = new Set(significantTokens(sourceMarkdown).map(lexicalRoot));
  const runs = [];
  let current = [];

  significantTokens(value).forEach(token => {
    if (sourceRoots.has(lexicalRoot(token))) {
      if (current.length >= minimumLength) runs.push(current);
      current = [];
    } else {
      current.push(token);
    }
  });
  if (current.length >= minimumLength) runs.push(current);
  return runs;
}

function validateAnchoredEditorialText(section, value, fieldPath, { detectRuns = true } = {}) {
  const issues = [];
  const sourceRoots = new Set(significantTokens(section.content_markdown).map(lexicalRoot));
  const unanchoredRiskWords = significantTokens(value)
    .map(token => normalizeWord(token))
    .filter(token => HIGH_RISK_UNANCHORED_WORDS.has(token) && !sourceRoots.has(lexicalRoot(token)));
  if (unanchoredRiskWords.length > 0) {
    issues.push(
      `${fieldPath}: intensificadores ou garantias nao ancorados na fonte: ${[...new Set(unanchoredRiskWords)].join(', ')}.`
    );
  }

  if (detectRuns) {
    const runs = findUnanchoredRuns(value, section.content_markdown);
    if (runs.length > 0) {
      issues.push(
        `${fieldPath}: sequencia editorial nao ancorada na fonte: "${runs[0].join(' ')}".`
      );
    }
  }
  return issues;
}

function extractMermaidGraph(mermaid) {
  const nodes = new Set();
  const edges = [];
  const lines = String(mermaid || '').split(/\r?\n/);
  const edgePattern = /([A-Za-z][\w-]*)\s*(?:-->|---|==>|-\.->|--o|--x)\s*(?:\|([^|]*)\|\s*)?([A-Za-z][\w-]*)/g;

  lines.forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || /^(flowchart|graph|subgraph|end|direction|class|classDef|style|linkStyle)\b/i.test(trimmed)) {
      return;
    }

    const declarationPattern = /(?:^|[;\s])([A-Za-z][\w-]*)\s*(?=\[|\(|\{)/g;
    let declaration;
    while ((declaration = declarationPattern.exec(trimmed)) !== null) nodes.add(declaration[1]);

    const edgeSource = trimmed.replace(
      /([A-Za-z][\w-]*)\s*(?:\[[^\]]*\]|\([^)]*\)|\{[^}]*\})/g,
      '$1'
    );
    let edge;
    while ((edge = edgePattern.exec(edgeSource)) !== null) {
      nodes.add(edge[1]);
      nodes.add(edge[3]);
      edges.push([edge[1], edge[3], String(edge[2] || '').trim()]);
    }
  });

  return { nodes, edges };
}

function validateMermaidConnectivity(sectionId, mermaid) {
  if (typeof mermaid !== 'string' || !mermaid.trim()) {
    return [];
  }
  if (!/^\s*(?:flowchart|graph)\s+(?:TD|TB)\b/im.test(mermaid)) {
    return [`${sectionId}.mermaid_mindmap: use somente flowchart TD ou TB; mapas laterais devem ser substituidos por outro recurso didatico.`];
  }
  if (/^\s*subgraph\b/im.test(mermaid)) {
    return [`${sectionId}.mermaid_mindmap: subgraph nao e permitido em mapas compactos.`];
  }
  if (/\b(?:Grupo tem[aá]tico|Eixo comparativo)\s+\d+\b/i.test(mermaid)) {
    return [`${sectionId}.mermaid_mindmap: agrupadores sinteticos genericos nao substituem relacoes tecnicas diretas.`];
  }
  const { nodes, edges } = extractMermaidGraph(mermaid);
  if (nodes.size > MERMAID_MAX_NODES) {
    return [`${sectionId}.mermaid_mindmap: mapa extenso (${nodes.size} nos); o limite e ${MERMAID_MAX_NODES}.`];
  }
  if (edges.length > MERMAID_MAX_EDGES) {
    return [`${sectionId}.mermaid_mindmap: mapa extenso (${edges.length} relacoes); o limite e ${MERMAID_MAX_EDGES}.`];
  }
  if (nodes.size < 2) {
    return [`${sectionId}.mermaid_mindmap: o mapa deve possuir ao menos dois nos relacionados.`];
  }
  if (edges.length === 0) {
    return [`${sectionId}.mermaid_mindmap: o mapa nao possui relacoes explicitas.`];
  }
  const unlabeledEdges = edges.filter(([, , label]) => significantTokens(label).length === 0);
  if (unlabeledEdges.length > 0) {
    return [`${sectionId}.mermaid_mindmap: toda aresta deve declarar um rotulo semantico entre |pipes|.`];
  }

  const fanout = new Map([...nodes].map(node => [node, 0]));
  edges.forEach(([left]) => fanout.set(left, (fanout.get(left) || 0) + 1));
  const excessiveFanout = [...fanout.entries()].find(([, count]) => count > MERMAID_MAX_FANOUT);
  if (excessiveFanout) {
    return [`${sectionId}.mermaid_mindmap: o no ${excessiveFanout[0]} possui ${excessiveFanout[1]} filhos; o limite e ${MERMAID_MAX_FANOUT}.`];
  }

  const adjacency = new Map([...nodes].map(node => [node, new Set()]));
  edges.forEach(([left, right]) => {
    adjacency.get(left).add(right);
    adjacency.get(right).add(left);
  });
  const firstNode = nodes.values().next().value;
  const visited = new Set([firstNode]);
  const queue = [firstNode];
  while (queue.length > 0) {
    const current = queue.shift();
    adjacency.get(current).forEach(neighbor => {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    });
  }

  const disconnected = [...nodes].filter(node => !visited.has(node));
  return disconnected.length > 0
    ? [`${sectionId}.mermaid_mindmap: nos sem relacao com o grafo principal: ${disconnected.join(', ')}.`]
    : [];
}

function validateEnrichmentQuality(unit, response) {
  const issues = [];
  response.sections.forEach(enrichment => {
    const sourceSection = unit.sections.find(section => section.section_id === enrichment.section_id);
    enrichment.callouts.forEach((callout, index) => {
      issues.push(...validateAnchoredEditorialText(
        sourceSection,
        callout.title,
        `${enrichment.section_id}.callouts[${index}].title`,
        { detectRuns: false }
      ));
      issues.push(...validateAnchoredEditorialText(
        sourceSection,
        callout.text,
        `${enrichment.section_id}.callouts[${index}].text`
      ));
    });
    enrichment.flashcards.forEach((flashcard, index) => {
      issues.push(...validateAnchoredEditorialText(
        sourceSection,
        flashcard.question,
        `${enrichment.section_id}.flashcards[${index}].question`,
        { detectRuns: false }
      ));
      issues.push(...validateAnchoredEditorialText(
        sourceSection,
        flashcard.answer,
        `${enrichment.section_id}.flashcards[${index}].answer`
      ));
    });
    issues.push(...validateSectionFlashcards(sourceSection, enrichment.flashcards, {
      requireLegalCard: /^Direito\b/iu.test(String(unit.discipline || '').trim()),
    }));
    issues.push(...validateMermaidConnectivity(enrichment.section_id, enrichment.mermaid_mindmap));
  });

  if (issues.length > 0) {
    throw new EnrichmentQualityError('Resposta reprovada na validacao de qualidade.', issues);
  }
  return response;
}

module.exports = {
  EnrichmentQualityError,
  QUALITY_RULES_VERSION,
  extractMermaidGraph,
  findUnanchoredRuns,
  validateAnchoredEditorialText,
  validateEnrichmentQuality,
  validateMermaidConnectivity,
};
