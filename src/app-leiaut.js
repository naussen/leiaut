const { Type } = require('@google/genai');
const fs = require('fs');
const path = require('path');
const { createVertexAIClient, getVertexAIConfig } = require('./config/vertex-ai');
const { estimateTokens, splitContentIntoBlocks } = require('./services/tokenService');
const { validateTopicFlashcards } = require('./leiaut/flashcard-quality');
const {
    loadVisualManifest,
    buildVisualPromptInstruction,
} = require('./visual/visualManifestReader');
const {
    validateVisualManifestOutput,
    writeVisualValidationReport,
} = require('./visual/visualComplianceValidator');
require('dotenv').config();

/**
 * Módulo LEIAUT - Conversor de Markdown para JSON Estruturado via Vertex AI
 * Focado em alimentação de plataforma de estudos (Next.js + Supabase + Mermaid.js)
 * Versão com Logs de Validação e Limpeza de Mermaid.js
 */

// O cliente é inicializado somente quando há chamada de IA. Assim, testes e modos
// determinísticos não exigem credenciais, projeto GCP ou acesso à rede.
let vertexAIClient = null;
let lastVertexRequestFinishedAt = 0;

function getVertexAIClient() {
  if (!vertexAIClient) {
    vertexAIClient = createVertexAIClient();
  }
  return vertexAIClient;
}

const DEFAULT_LEIAUT_MAX_INPUT_TOKENS = 30000;
const DEFAULT_LEIAUT_BLOCK_INPUT_TOKENS = 5000;
const DEFAULT_LEIAUT_MAX_SECTION_TOKENS = 10000;
const DEFAULT_LEIAUT_TIMEOUT_MS = 180000;
const DEFAULT_LEIAUT_MAX_RETRIES = 2;
const DEFAULT_LEIAUT_MAX_TOKEN_RETRIES = 3;
const DEFAULT_LEIAUT_RETRY_BASE_DELAY_MS = 10000;
const DEFAULT_LEIAUT_RETRY_MAX_DELAY_MS = 60000;
const DEFAULT_LEIAUT_REQUEST_COOLDOWN_MS = 2000;
const DEFAULT_LEIAUT_MIN_OUTPUT_TOKENS = 4096;
const DEFAULT_LEIAUT_MAX_OUTPUT_TOKENS = 65536;
const DEFAULT_LEIAUT_OUTPUT_TOKEN_MULTIPLIER = 2;
const DEFAULT_LEIAUT_OUTPUT_TOKEN_RETRY_MULTIPLIER = 2;
const DEFAULT_LEIAUT_MAX_OUTPUT_TOKEN_RETRY_MULTIPLIER = 8;
const DEFAULT_LEIAUT_THINKING_BUDGET = 0;
const MAX_LEIAUT_RETRIES = 2;
const MAX_LEIAUT_TOKEN_RETRIES = 3;
const RETRYABLE_VERTEX_STATUSES = new Set([429, 500, 503]);
const MAX_MARKDOWN_LINE_LENGTH = 20000;
const MAX_HORIZONTAL_WHITESPACE_RUN = 1000;
const CANONICAL_ACRONYMS = new Map([
    ['AFO', 'AFO'], ['CIDE', 'CIDE'], ['CLT', 'CLT'], ['CPC', 'CPC'],
    ['CPP', 'CPP'], ['CTN', 'CTN'], ['CVM', 'CVM'], ['DCS', 'DCs'],
    ['DRE', 'DRE'], ['EG', 'EG'], ['FRF', 'FRF'], ['ICMS', 'ICMS'],
    ['ISS', 'ISS'], ['LDO', 'LDO'], ['LINDB', 'LINDB'], ['LOA', 'LOA'],
    ['LRF', 'LRF'], ['NBC', 'NBC'], ['PL', 'PL'], ['PPA', 'PPA'],
    ['RT', 'RT'], ['STF', 'STF'], ['STJ', 'STJ'], ['TA', 'TA'],
    ['TCE', 'TCE'], ['TCU', 'TCU'], ['TI', 'TI'],
]);

function getPositiveIntegerEnv(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isInteger(value) && value > 0 ? value : fallback;
}

function getNonNegativeIntegerEnv(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function parseLeiautArgs(args) {
    const valueOptions = new Set(['--visual-manifest']);
    const positional = [];
    for (let index = 0; index < args.length; index += 1) {
        if (valueOptions.has(args[index])) {
            if (!args[index + 1] || args[index + 1].startsWith('--')) {
                const error = new Error('--visual-manifest exige o caminho de um arquivo JSON.');
                error.code = 'LEIAUT_VISUAL_MANIFEST_PATH_REQUIRED';
                throw error;
            }
            index += 1;
            continue;
        }
        if (!args[index].startsWith('--')) positional.push(args[index]);
    }
    return {
        inputFile: positional[0] || 'direito_constitucional.md',
        forceLarge: args.includes('--force-large'),
        noAi: args.includes('--no-ai') || args.includes('--split-by-topic'),
        splitByTopic: args.includes('--split-by-topic'),
        dryRun: args.includes('--dry-run'),
        visualManifest: (() => {
            const index = args.indexOf('--visual-manifest');
            return index >= 0 ? args[index + 1] || null : null;
        })(),
    };
}

function resolveMarkdownInputPaths(inputPath) {
    const inputStats = fs.statSync(inputPath);
    if (inputStats.isFile()) {
      return {
        inputType: 'file',
        files: [inputPath]
      };
    }

    if (!inputStats.isDirectory()) {
      const error = new Error(`O caminho de entrada não é um arquivo nem um diretório: ${inputPath}`);
      error.code = 'LEIAUT_INPUT_TYPE_INVALID';
      throw error;
    }

    const files = fs.readdirSync(inputPath, { withFileTypes: true })
      .filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === '.md')
      .map(entry => path.join(inputPath, entry.name))
      .sort((left, right) => path.basename(left).localeCompare(
        path.basename(right),
        'pt-BR',
        { numeric: true, sensitivity: 'base' }
      ));

    if (files.length === 0) {
      const error = new Error(`Nenhum arquivo Markdown (.md) foi encontrado diretamente em: ${inputPath}`);
      error.code = 'LEIAUT_INPUT_DIRECTORY_EMPTY';
      throw error;
    }

    return {
      inputType: 'directory',
      files
    };
}

function countMarkdownHeadings(content) {
    return (content.match(/^#{1,3}\s+/gm) || []).length;
}

function normalizeInlineTopicMarkers(content) {
    return String(content || '').replace(
        /^([ \t]*)@@@[ \t]+(##(?!#)[ \t]+\S.*)$/gm,
        '$1@@@\n$1$2'
    );
}

function removePygemRecoveryMarkers(content) {
    return String(content || '')
        .split(/\r?\n/)
        .filter(line => {
            const markerText = line
                .trim()
                .replace(/^@@@[ \t]*/, '')
                .replace(/^##(?!#)[ \t]*/, '')
                .replace(/[ \t]+#+[ \t]*$/, '')
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .toLocaleLowerCase('pt-BR')
                .trim();
            return markerText !== 'recuperacao de bloco';
        })
        .join('\n');
}

function getMarkdownOutline(content, limit = 40) {
    return String(content || '')
        .split(/\r?\n/)
        .filter(line => /^#{1,3}\s+\S/.test(line.trim()))
        .slice(0, limit)
        .map(line => line.trim())
        .join('\n');
}

function stripHeadingSyntax(line) {
    return String(line || '')
        .replace(/^#{1,6}\s+/, '')
        .replace(/\s+#+\s*$/, '')
        .trim();
}

function replaceKnownPortugueseTypos(value) {
    return String(value || '').replace(/\bDOUTINA\b/gi, 'DOUTRINA');
}

function normalizeTitleKey(value) {
    return replaceKnownPortugueseTypos(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeLegalArticleCitationKey(value) {
    return normalizeTitleKey(value).replace(/\barts?\b(?=\s+\d)/g, 'art');
}

function isPredominantlyUppercaseTitle(value) {
    const letters = String(value || '').match(/\p{L}/gu) || [];
    if (letters.length < 2) return false;
    const uppercaseCount = letters.filter(letter => letter === letter.toUpperCase()).length;
    return uppercaseCount / letters.length >= 0.8;
}

function collectContextualAcronyms(value) {
    return new Set(
        (String(value || '').match(/\b[\p{Lu}\d]{2,12}\b/gu) || [])
            .filter(token => /\p{Lu}/u.test(token))
    );
}

function normalizeStudyTitle(value, contextText = '') {
    const corrected = replaceKnownPortugueseTypos(value).replace(/\s+/g, ' ').trim();
    if (!corrected || !isPredominantlyUppercaseTitle(corrected)) return corrected;

    const contextualAcronyms = collectContextualAcronyms(contextText);
    let capitalizedDescriptiveWord = false;
    return corrected.replace(/[\p{L}\p{N}]+/gu, token => {
        const canonicalAcronym = CANONICAL_ACRONYMS.get(token.toUpperCase());
        if (canonicalAcronym) return canonicalAcronym;
        if (contextualAcronyms.has(token)) return token;
        if (/^(?:[IVXLCDM]+|\d+)$/i.test(token)) return token.toUpperCase();

        const lower = token.toLocaleLowerCase('pt-BR');
        if (capitalizedDescriptiveWord) return lower;
        capitalizedDescriptiveWord = true;
        return lower.charAt(0).toLocaleUpperCase('pt-BR') + lower.slice(1);
    });
}

function normalizeKnownTyposDeep(value) {
    if (typeof value === 'string') return replaceKnownPortugueseTypos(value);
    if (Array.isArray(value)) return value.map(normalizeKnownTyposDeep);
    if (!value || typeof value !== 'object') return value;

    Object.keys(value).forEach(key => {
        value[key] = normalizeKnownTyposDeep(value[key]);
    });
    return value;
}

function removeOrphanMarkdownHeadings(markdown) {
    const lines = String(markdown || '').split(/\r?\n/);
    return lines.filter((line, index) => {
        const heading = line.match(/^(#{1,6})\s+\S/);
        if (!heading) return true;

        for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
            const nextLine = lines[nextIndex].trim();
            if (!nextLine) continue;
            const nextHeading = nextLine.match(/^(#{1,6})\s+\S/);
            return !nextHeading || nextHeading[1].length > heading[1].length;
        }
        return false;
    }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function getLevelTwoHeadingTitles(markdown) {
    const titleContext = getTitleNormalizationContext(markdown);
    return String(markdown || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => /^##(?!#)\s+\S/.test(line))
        .map(line => normalizeStudyTitle(stripHeadingSyntax(line), titleContext));
}

function getStudyContentContext(data) {
    if (!Array.isArray(data?.sections)) return '';
    return data.sections.map(section => JSON.stringify({
        content_markdown: section?.content_markdown,
        callouts: section?.callouts,
        mnemonics: section?.mnemonics,
        flashcards: section?.flashcards,
        mermaid_mindmap: section?.mermaid_mindmap,
    })).join('\n');
}

function validateMarkdownInput(markdown) {
    const issues = [];
    const lines = String(markdown || '').split(/\r?\n/);
    const whitespacePattern = new RegExp(`[\\t ]{${MAX_HORIZONTAL_WHITESPACE_RUN},}`);

    lines.forEach((line, index) => {
        if (line.length > MAX_MARKDOWN_LINE_LENGTH) {
            issues.push(
                `linha ${index + 1} possui ${line.length} caracteres; limite seguro ${MAX_MARKDOWN_LINE_LENGTH}`
            );
        }
        if (whitespacePattern.test(line)) {
            issues.push(`linha ${index + 1} contém uma sequência patológica de espaços horizontais`);
        }
    });

    const seenTitles = new Set();
    getLevelTwoHeadingTitles(markdown).forEach(title => {
        const key = normalizeTitleKey(title);
        if (seenTitles.has(key)) {
            issues.push(`título principal duplicado: "${title}"`);
        }
        seenTitles.add(key);
    });

    lines.forEach((line, index) => {
        const heading = line.trim().match(/^##(?!#)\s+(.+?)\s*#*\s*$/);
        if (!heading) return;

        const nextContentLine = lines
            .slice(index + 1)
            .find(candidate => candidate.trim() && !/^@@@\s*$/.test(candidate.trim()));
        const nextHeading = nextContentLine?.trim().match(/^(#{1,6})\s+\S/);
        if (!nextContentLine || (nextHeading && nextHeading[1].length <= 2)) {
            issues.push(
                `título principal sem conteúdo antes da próxima seção: "${heading[1].trim()}"`
            );
        }
    });

    return { valid: issues.length === 0, issues };
}

function sectionHasUsefulContent(section) {
    return Boolean(
        typeof section?.content_markdown === 'string' && section.content_markdown.trim()
        || typeof section?.mermaid_mindmap === 'string' && section.mermaid_mindmap.trim()
        || Array.isArray(section?.callouts) && section.callouts.length
        || Array.isArray(section?.mnemonics) && section.mnemonics.length
        || Array.isArray(section?.flashcards) && section.flashcards.length
    );
}

function assertImportableSections(data) {
    const emptySections = Array.isArray(data?.sections)
        ? data.sections
            .map((section, index) => ({ section, index }))
            .filter(({ section }) => !sectionHasUsefulContent(section))
        : [];

    if (emptySections.length > 0) {
        const details = emptySections.map(({ section, index }) => (
            `seção ${index + 1} ('${section?.title || 'sem título'}')`
        ));
        const error = new Error(
            'A resposta contém seção sem conteúdo nem recurso didático: '
            + `${details.join(', ')}. Corrija a estrutura Markdown ou regenere o conteúdo.`
        );
        error.code = 'LEIAUT_SECTION_EMPTY';
        error.details = details;
        throw error;
    }

    return data;
}

function assertSectionStructureMatchesSource(data, markdown) {
    const expectedTitles = getLevelTwoHeadingTitles(markdown);
    if (expectedTitles.length === 0) return data;

    const actualTitles = Array.isArray(data?.sections)
        ? data.sections.map(section => normalizeStudyTitle(section?.title))
        : [];
    const expectedKeys = expectedTitles.map(normalizeTitleKey);
    const actualKeys = actualTitles.map(normalizeTitleKey);
    const sameStructure = expectedKeys.length === actualKeys.length
        && expectedKeys.every((key, index) => key === actualKeys[index]);

    if (!sameStructure) {
        const error = new Error(
            'A estrutura de seções não corresponde aos títulos ## da fonte. '
            + `Esperado (${expectedTitles.length}): ${expectedTitles.join(' | ')}. `
            + `Recebido (${actualTitles.length}): ${actualTitles.join(' | ')}.`
        );
        error.code = 'LEIAUT_SECTION_STRUCTURE_INVALID';
        throw error;
    }
    return data;
}

function canonicalizeSectionTitlesFromSource(data, markdown) {
    const expectedTitles = getLevelTwoHeadingTitles(markdown);
    if (!Array.isArray(data?.sections) || data.sections.length !== expectedTitles.length) return data;

    data.sections.forEach((section, index) => {
        const expectedTitle = expectedTitles[index];
        const actualTitle = normalizeStudyTitle(section?.title);
        const exactMatch = normalizeTitleKey(actualTitle) === normalizeTitleKey(expectedTitle);
        const legalArticleAbbreviationMatch = normalizeLegalArticleCitationKey(actualTitle)
            === normalizeLegalArticleCitationKey(expectedTitle);
        const expectedWithoutParenthetical = expectedTitle
            .replace(/\s*\([^()]*\)\s*/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        const omittedParenthetical = expectedWithoutParenthetical !== expectedTitle
            && normalizeTitleKey(actualTitle) === normalizeTitleKey(expectedWithoutParenthetical);

        if (exactMatch || legalArticleAbbreviationMatch || omittedParenthetical) {
            section.title = expectedTitle;
        }
    });

    return data;
}

function getMarkdownHeadingSections(markdown) {
    const lines = String(markdown || '').split(/\r?\n/);
    const headings = [];

    lines.forEach((line, index) => {
        const match = line.trim().match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
        if (!match) return;
        headings.push({
            index,
            level: match[1].length,
            title: normalizeStudyTitle(stripHeadingSyntax(line.trim()), markdown),
        });
    });

    return headings.map((heading, index) => {
        const nextHeading = headings
            .slice(index + 1)
            .find(candidate => candidate.level <= heading.level);
        const bodyEnd = nextHeading ? nextHeading.index : lines.length;
        return {
            title: heading.title,
            body: lines.slice(heading.index + 1, bodyEnd).join('\n').trim(),
        };
    });
}

function getTitleNormalizationContext(content) {
    return String(content || '')
        .split(/\r?\n/)
        .filter(line => {
            const trimmed = line.trim();
            return !/^@@@?[ \t]+(?!#)/.test(trimmed)
                && !/^#{1,6}\s+\S/.test(trimmed);
        })
        .join('\n');
}

function recoverEmptySectionsFromSource(data, markdown) {
    if (!Array.isArray(data?.sections)) return data;

    const sourceSectionsByTitle = new Map();
    getMarkdownHeadingSections(markdown).forEach(sourceSection => {
        const key = normalizeTitleKey(sourceSection.title);
        const entries = sourceSectionsByTitle.get(key) || [];
        entries.push(sourceSection);
        sourceSectionsByTitle.set(key, entries);
    });

    data.sections.forEach((section, index) => {
        if (sectionHasUsefulContent(section)) return;

        const candidates = sourceSectionsByTitle.get(normalizeTitleKey(section?.title)) || [];
        if (candidates.length !== 1) return;

        const sourceBody = candidates[0].body;
        const meaningfulBody = sourceBody.replace(/^@@@\s*$/gm, '').trim();
        if (!meaningfulBody) return;

        section.content_markdown = sourceBody;
        console.warn(
            `⚠️ Seção ${index + 1} ('${section.title}') veio vazia da IA; `
            + 'o corpo Markdown literal do cabeçalho único correspondente foi restaurado da fonte.'
        );
    });

    return data;
}

function titleFromFileName(filePath) {
    const baseName = path.basename(filePath, path.extname(filePath));
    const spaced = baseName.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!spaced) return 'Titulo Indefinido';
    return spaced.replace(/\b\w/g, char => char.toUpperCase());
}

const canonicalDisciplines = [
    "Direito Constitucional", "Direito Administrativo", "Direito Penal", "Direito Civil",
    "Direito Processual Civil", "Direito Processual Penal", "Direito do Trabalho",
    "Direito Tributário", "Direito Empresarial", "Legislação Especial",
    "Contabilidade", "Administração Financeira e Orçamentária", "Administração",
    "Economia", "Português", "Matemática", "Raciocínio Lógico", "Informática"
];

function normalizeDisciplineSearchText(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function inferDisciplineFromFileName(filePath = '') {
    const fileName = path.basename(filePath, path.extname(filePath));
    const normalizedFileName = normalizeDisciplineSearchText(fileName);
    if (!normalizedFileName) return null;

    return canonicalDisciplines.find(discipline =>
        normalizedFileName.includes(normalizeDisciplineSearchText(discipline))
    ) || null;
}

function slugify(value, fallback = 'topico') {
    const slug = String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

    return slug || fallback;
}

function inferDiscipline(content, filePath = '') {
    const disciplineFromFileName = inferDisciplineFromFileName(filePath);
    if (disciplineFromFileName) return disciplineFromFileName;

    const firstHeading = String(content || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(line => /^#{1,6}\s+\S/.test(line));
    const normalizedFirstHeading = normalizeDisciplineSearchText(
        firstHeading ? stripHeadingSyntax(firstHeading) : ''
    );
    const disciplineFromFirstHeading = canonicalDisciplines.find(discipline =>
        normalizedFirstHeading.includes(normalizeDisciplineSearchText(discipline))
    );
    if (disciplineFromFirstHeading) return disciplineFromFirstHeading;

    const textSample = String(content || '').slice(0, 12000);
    const normalizedText = textSample.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

    const rules = [
        { pattern: /\bdireito constitucional\b|\bconstituicao federal\b|\bart\.?\s*5[oº]?\b/, discipline: 'Direito Constitucional' },
        { pattern: /\bdireito administrativo\b|\bato administrativo\b|\blicitac(ao|oes)\b/, discipline: 'Direito Administrativo' },
        { pattern: /\bdireito penal\b|\bcrime\b|\bpena\b/, discipline: 'Direito Penal' },
        { pattern: /\bdireito civil\b|\blindb\b|\bpessoas naturais\b|\bpessoas juridicas\b|\bdireito das obrigacoes\b/, discipline: 'Direito Civil' },
        { pattern: /\bdireito processual civil\b|\bcodigo de processo civil\b|\bcpc\b/, discipline: 'Direito Processual Civil' },
        { pattern: /\bdireito processual penal\b|\bcodigo de processo penal\b|\bcpp\b/, discipline: 'Direito Processual Penal' },
        { pattern: /\bdireito do trabalho\b|\bclt\b|\bempregado\b|\bempregador\b/, discipline: 'Direito do Trabalho' },
        { pattern: /\bdireito tributario\b|\btributo\b|\bimposto\b|\bctn\b/, discipline: 'Direito Tributário' },
        { pattern: /\bdireito empresarial\b|\bsociedade empresaria\b|\bfalencia\b/, discipline: 'Direito Empresarial' },
        { pattern: /\bcontabilidade\b|\bbalanco patrimonial\b|\bdemonstracao do resultado\b|\bdre\b/, discipline: 'Contabilidade' },
        { pattern: /\badministracao financeira e orcamentaria\b|\borcamento publico\b|\bafo\b/, discipline: 'Administração Financeira e Orçamentária' },
        { pattern: /\bportugues\b|\bgramatica\b|\bsintaxe\b|\bmorfologia\b/, discipline: 'Português' },
        { pattern: /\bmatematica\b|\bporcentagem\b|\bequacao\b|\bprobabilidade\b/, discipline: 'Matemática' },
        { pattern: /\braciocinio logico\b|\blogica proposicional\b/, discipline: 'Raciocínio Lógico' },
        { pattern: /\binformatica\b|\bseguranca da informacao\b|\bhardware\b|\bsoftware\b/, discipline: 'Informática' }
    ];

    const found = rules.find(rule => rule.pattern.test(normalizedText));
    return found ? found.discipline : 'Geral';
}

function getFirstHeadingTitle(content, fallbackTitle) {
    const firstHeading = String(content || '').split('\n').find(line => /^#{1,6}\s+\S/.test(line.trim()));
    return normalizeStudyTitle(
        firstHeading ? stripHeadingSyntax(firstHeading.trim()) : fallbackTitle,
        getTitleNormalizationContext(content)
    );
}

function extractOriginalDocumentTitle(content) {
    const normalizedContent = String(content || '').replace(/^\uFEFF/, '');
    const lines = normalizedContent.split(/\r?\n/);
    const firstContentIndex = lines.findIndex(line => line.trim());
    const firstContentLine = firstContentIndex >= 0 ? lines[firstContentIndex] : null;
    const match = firstContentLine?.trim().match(/^@@@?[ \t]+(?!#)(\S.*?)[ \t]*$/);
    if (!match) return null;

    const normalizedMarkerTitle = normalizeTitleKey(match[1]);
    return normalizedMarkerTitle === 'recuperacao de bloco'
        ? null
        : normalizeStudyTitle(match[1], getTitleNormalizationContext(normalizedContent));
}

function getCanonicalTopicTitle(content, fallbackTitle) {
    return extractOriginalDocumentTitle(content)
        ?? getFirstHeadingTitle(content, fallbackTitle);
}

function getOriginalDocumentTitleFromFile(sourceFilePath) {
    if (!sourceFilePath || !fs.existsSync(sourceFilePath)) return null;
    const stats = fs.statSync(sourceFilePath);
    if (!stats.isFile()) return null;
    return extractOriginalDocumentTitle(fs.readFileSync(sourceFilePath, 'utf8'));
}

function splitByHeadingLevel(content, level) {
    const headingPattern = new RegExp(`^#{${level}}\\s+\\S`);
    const lines = String(content || '').split(/\r?\n/);
    const preface = [];
    const blocks = [];
    let current = null;

    lines.forEach(line => {
        if (headingPattern.test(line.trim())) {
            if (current) blocks.push(current);
            current = {
                title: stripHeadingSyntax(line.trim()),
                bodyLines: []
            };
            return;
        }

        if (current) {
            current.bodyLines.push(line);
        } else {
            preface.push(line);
        }
    });

    if (current) blocks.push(current);

    return {
        preface: preface.join('\n').trim(),
        blocks: blocks.map(block => ({
            title: block.title,
            body: block.bodyLines.join('\n').trim()
        }))
    };
}

function makeEmptyStudySection(sectionId, title, contentMarkdown) {
    return {
        section_id: sectionId,
        title,
        content_markdown: contentMarkdown || '',
        callouts: [],
        mnemonics: [],
        flashcards: [],
        mermaid_mindmap: ''
    };
}

function buildDeterministicTopic(
    topicTitle,
    topicMarkdown,
    discipline,
    topicIdBase,
    sectionHeadingLevel = 3,
    options = {}
) {
    const normalizedTopicTitle = options.preserveTopicTitle
        ? String(topicTitle || '').trim()
        : normalizeStudyTitle(topicTitle, topicMarkdown);
    const topicId = slugify(topicIdBase || normalizedTopicTitle, 'topico-indefinido');
    const sections = [];
    const sectionSplit = splitByHeadingLevel(topicMarkdown, sectionHeadingLevel);

    if (sectionSplit.preface) {
        sections.push(makeEmptyStudySection('', normalizedTopicTitle, sectionSplit.preface));
    }

    sectionSplit.blocks.forEach(block => {
        sections.push(makeEmptyStudySection('', normalizeStudyTitle(block.title, block.body), block.body));
    });

    if (sections.length === 0) {
        sections.push(makeEmptyStudySection('', normalizedTopicTitle, topicMarkdown.trim()));
    }

    const data = {
        topic_id: topicId,
        topic_title: normalizedTopicTitle,
        discipline,
        sections
    };

    renumberSectionIds(data);
    return data;
}

function buildDeterministicOutputs(markdownContent, inputPath, options = {}) {
    const originalDocumentTitle = extractOriginalDocumentTitle(markdownContent);
    const fallbackTitle = getCanonicalTopicTitle(markdownContent, titleFromFileName(inputPath));
    const discipline = inferDiscipline(markdownContent, inputPath);

    if (!options.splitByTopic) {
        const data = buildDeterministicTopic(
            fallbackTitle,
            markdownContent,
            discipline,
            fallbackTitle,
            2,
            { preserveTopicTitle: Boolean(originalDocumentTitle) }
        );
        return [{ fileSuffix: '', data }];
    }

    const topicSplit = splitByHeadingLevel(markdownContent, 2);
    const sourceTopics = topicSplit.blocks.length > 0
        ? topicSplit.blocks
        : [{ title: fallbackTitle, body: markdownContent }];

    const outputs = [];
    if (topicSplit.preface) {
        const prefaceTitle = fallbackTitle === titleFromFileName(inputPath) ? 'Introducao' : fallbackTitle;
        outputs.push({
            fileSuffix: `001-${slugify(prefaceTitle)}`,
            data: buildDeterministicTopic(
                prefaceTitle,
                topicSplit.preface,
                discipline,
                prefaceTitle,
                3,
                { preserveTopicTitle: Boolean(originalDocumentTitle) }
            )
        });
    }

    const topicSequenceStart = outputs.length + 1;
    sourceTopics.forEach((topic, index) => {
        const sequence = String(topicSequenceStart + index).padStart(3, '0');
        outputs.push({
            fileSuffix: `${sequence}-${slugify(topic.title)}`,
            data: buildDeterministicTopic(topic.title, topic.body, discipline, topic.title, 3)
        });
    });

    return outputs;
}

function writeJsonOutput(outputPath, data) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const temporaryPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
    try {
        fs.writeFileSync(temporaryPath, JSON.stringify(data, null, 2), 'utf-8');
        fs.renameSync(temporaryPath, outputPath);
    } finally {
        if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
}

function saveDeterministicOutputs(outputs, inputPath, dryRun = false, outputBaseDir = process.cwd()) {
    const parsed = path.parse(inputPath);

    if (outputs.length === 1) {
        const outputPath = path.join(outputBaseDir, `${parsed.name}_processado.json`);
        if (!dryRun) writeJsonOutput(outputPath, outputs[0].data);
        return [outputPath];
    }

    const outputDir = path.join(outputBaseDir, `${parsed.name}_processado`);
    if (!dryRun && !fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    return outputs.map(output => {
        const outputPath = path.join(outputDir, `${output.fileSuffix}.json`);
        if (!dryRun) writeJsonOutput(outputPath, output.data);
        return outputPath;
    });
}

function printOutputPaths(outputPaths, limit = 20) {
    const visiblePaths = outputPaths.slice(0, limit);
    visiblePaths.forEach(outputPath => console.log(`📂 ${outputPath}`));

    if (outputPaths.length > limit) {
        console.log(`📂 ... mais ${outputPaths.length - limit} arquivo(s) omitido(s) no log.`);
    }
}

function getVertexErrorStatus(error) {
    const candidates = [
        error?.status,
        error?.code,
        error?.error?.code,
        error?.cause?.status,
        error?.cause?.code,
    ];

    for (const candidate of candidates) {
        const numericStatus = Number(candidate);
        if (Number.isInteger(numericStatus)) return numericStatus;
    }

    const message = String(error?.message || error || '');
    const statusMatch = message.match(/(?:"code"\s*:\s*|\b)(429|500|503)\b/);
    if (statusMatch) return Number(statusMatch[1]);
    if (/RESOURCE_EXHAUSTED/i.test(message)) return 429;
    if (/\bUNAVAILABLE\b/i.test(message)) return 503;
    return null;
}

function isRetryableVertexError(error) {
    return error?.code === 'LEIAUT_MAX_TOKENS'
        || RETRYABLE_VERTEX_STATUSES.has(getVertexErrorStatus(error));
}

function shouldRetryVertexFailure(error, retryState) {
    if (error?.code === 'LEIAUT_MAX_TOKENS') {
        return retryState.maxTokenFailureCount <= retryState.maxTokenRetries;
    }
    return isRetryableVertexError(error)
        && retryState.transientFailureCount <= retryState.maxTransientRetries;
}

function getVertexFinishReason(response) {
    return response?.candidates?.[0]?.finishReason
        || response?.response?.candidates?.[0]?.finishReason
        || null;
}

function getVertexTokenUsage(response) {
    const usage = response?.usageMetadata || response?.response?.usageMetadata || {};
    return {
        promptTokens: usage.promptTokenCount ?? null,
        candidateTokens: usage.candidatesTokenCount ?? null,
        thoughtTokens: usage.thoughtsTokenCount ?? null,
    };
}

function calculateFlexibleOutputTokens(contents, maxTokenFailureCount = 0, options = {}) {
    const minOutputTokens = Math.max(
        1,
        Number(options.minOutputTokens) || DEFAULT_LEIAUT_MIN_OUTPUT_TOKENS
    );
    const maxOutputTokens = Math.max(
        minOutputTokens,
        Number(options.maxOutputTokens) || DEFAULT_LEIAUT_MAX_OUTPUT_TOKENS
    );
    const outputTokenMultiplier = Math.max(
        1,
        Number(options.outputTokenMultiplier) || DEFAULT_LEIAUT_OUTPUT_TOKEN_MULTIPLIER
    );
    const retryMultiplier = Math.max(
        1,
        Number(options.outputTokenRetryMultiplier)
            || DEFAULT_LEIAUT_OUTPUT_TOKEN_RETRY_MULTIPLIER
    );
    const maxRetryMultiplier = Math.max(
        retryMultiplier,
        Number(options.maxOutputTokenRetryMultiplier)
            || DEFAULT_LEIAUT_MAX_OUTPUT_TOKEN_RETRY_MULTIPLIER
    );
    const baseBudget = Math.max(
        minOutputTokens,
        Math.ceil(estimateTokens(String(contents || '')) * outputTokenMultiplier)
    );
    const retryGrowth = Math.min(
        maxRetryMultiplier,
        retryMultiplier ** Math.max(0, maxTokenFailureCount)
    );

    return Math.min(maxOutputTokens, Math.ceil(baseBudget * retryGrowth));
}

function getHeaderValue(headers, name) {
    if (!headers) return null;
    if (typeof headers.get === 'function') return headers.get(name);

    const matchingKey = Object.keys(headers).find(key => key.toLowerCase() === name.toLowerCase());
    return matchingKey ? headers[matchingKey] : null;
}

function getRetryAfterMs(error, nowMs = Date.now()) {
    const headerSources = [
        error?.headers,
        error?.response?.headers,
        error?.sdkHttpResponse?.headers,
        error?.cause?.headers,
        error?.cause?.response?.headers,
    ];
    const rawValue = headerSources
        .map(headers => getHeaderValue(headers, 'retry-after'))
        .find(value => value !== null && value !== undefined && String(value).trim());
    if (rawValue === undefined || rawValue === null) return 0;

    const value = String(rawValue).trim();
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);

    const retryAt = Date.parse(value);
    return Number.isFinite(retryAt) ? Math.max(0, retryAt - nowMs) : 0;
}

function calculateRetryDelayMs(retryNumber, options = {}) {
    const baseDelayMs = Math.max(1, Number(options.baseDelayMs) || DEFAULT_LEIAUT_RETRY_BASE_DELAY_MS);
    const maxDelayMs = Math.max(baseDelayMs, Number(options.maxDelayMs) || DEFAULT_LEIAUT_RETRY_MAX_DELAY_MS);
    const randomValue = Math.min(1, Math.max(0, Number(options.randomValue ?? Math.random())));
    const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.max(0, retryNumber - 1)));
    const jitteredDelay = Math.min(maxDelayMs, Math.round(exponentialDelay * (0.8 + (randomValue * 0.4))));
    return Math.max(jitteredDelay, Math.max(0, Number(options.retryAfterMs) || 0));
}

function waitMilliseconds(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, milliseconds)));
}

async function waitForVertexCooldown(cooldownMs, label) {
    const remainingMs = Math.max(0, lastVertexRequestFinishedAt + cooldownMs - Date.now());
    if (remainingMs === 0) return;
    console.log(`⏳ Aguardando ${Math.ceil(remainingMs / 1000)}s antes de enviar ${label}, para suavizar o lote.`);
    await waitMilliseconds(remainingMs);
}

async function generateStructuredContent(modelName, contents, timeoutMs, label, retryOptions = {}) {
    const ai = getVertexAIClient();
    const maxTransientRetries = Math.min(
        MAX_LEIAUT_RETRIES,
        Math.max(0, Number(retryOptions.maxRetries) || 0)
    );
    const maxTokenRetries = Math.min(
        MAX_LEIAUT_TOKEN_RETRIES,
        Math.max(0, Number(retryOptions.maxTokenRetries) || 0)
    );
    const cooldownMs = Math.max(0, Number(retryOptions.requestCooldownMs) || 0);
    const maxAttempts = 1 + maxTransientRetries + maxTokenRetries;
    let transientFailureCount = 0;
    let maxTokenFailureCount = 0;

    await waitForVertexCooldown(cooldownMs, label);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

      try {
        const maxOutputTokens = calculateFlexibleOutputTokens(
          contents,
          maxTokenFailureCount,
          retryOptions
        );
        console.log(
          `🤖 Enviando ${label} ao Gemini (${modelName}) — tentativa `
          + `${attempt}/${maxAttempts}, orçamento ${maxOutputTokens.toLocaleString('pt-BR')} tokens...`
        );
        const response = await ai.models.generateContent({
          model: modelName,
          contents,
          config: {
            systemInstruction: systemInstruction,
            responseMimeType: "application/json",
            responseSchema: responseSchema,
            temperature: 0.2,
            maxOutputTokens,
            thinkingConfig: {
              thinkingBudget: Math.max(0, Number(retryOptions.thinkingBudget) || 0),
              includeThoughts: false
            },
            httpOptions: {
              timeout: timeoutMs,
              // O LEIAUT controla e registra os retries para evitar tentativas ocultas em cascata.
              retryOptions: { attempts: 1 }
            },
            abortSignal: abortController.signal
          }
        });

        if (getVertexFinishReason(response) === 'MAX_TOKENS') {
          const tokenUsage = getVertexTokenUsage(response);
          const truncationError = new Error(
            `Resposta truncada por MAX_TOKENS em ${label} com orçamento de `
            + `${maxOutputTokens} tokens.`
          );
          truncationError.code = 'LEIAUT_MAX_TOKENS';
          truncationError.maxOutputTokens = maxOutputTokens;
          truncationError.tokenUsage = tokenUsage;
          throw truncationError;
        }

        return response;
      } catch (error) {
        if (error?.code === 'LEIAUT_MAX_TOKENS') {
          maxTokenFailureCount += 1;
        } else if (isRetryableVertexError(error)) {
          transientFailureCount += 1;
        }
        const shouldRetry = shouldRetryVertexFailure(error, {
          transientFailureCount,
          maxTransientRetries,
          maxTokenFailureCount,
          maxTokenRetries,
        });
        if (!shouldRetry) {
          if (error?.code === 'LEIAUT_MAX_TOKENS') {
            const exhaustedError = new Error(
              `Resposta truncada por MAX_TOKENS após ${attempt} tentativa(s) em ${label}. `
              + `Orçamento final: ${error.maxOutputTokens} tokens; nenhum JSON parcial foi aceito.`
            );
            exhaustedError.code = 'LEIAUT_MAX_TOKENS';
            exhaustedError.attempts = attempt;
            exhaustedError.tokenUsage = error.tokenUsage;
            exhaustedError.cause = error;
            throw exhaustedError;
          }
          if (isRetryableVertexError(error) && attempt > 1) {
            const exhaustedError = new Error(
              `Falha transitória da Vertex AI após ${attempt} tentativas em ${label}. `
              + `Último erro: ${error?.message || String(error)}`
            );
            exhaustedError.code = 'LEIAUT_VERTEX_RETRIES_EXHAUSTED';
            exhaustedError.status = getVertexErrorStatus(error);
            exhaustedError.attempts = attempt;
            exhaustedError.cause = error;
            throw exhaustedError;
          }
          throw error;
        }

        const retryNumber = error?.code === 'LEIAUT_MAX_TOKENS'
          ? maxTokenFailureCount
          : transientFailureCount;
        const delayMs = calculateRetryDelayMs(retryNumber, {
          baseDelayMs: retryOptions.retryBaseDelayMs,
          maxDelayMs: retryOptions.retryMaxDelayMs,
          retryAfterMs: getRetryAfterMs(error)
        });
        console.warn(
          `⚠️ Vertex AI retornou ${error?.code === 'LEIAUT_MAX_TOKENS' ? 'MAX_TOKENS' : getVertexErrorStatus(error)} em ${label}. `
          + `${error?.tokenUsage?.candidateTokens != null
            ? `Uso informado: ${error.tokenUsage.candidateTokens.toLocaleString('pt-BR')} tokens de candidato`
                + `${error.tokenUsage.thoughtTokens != null
                  ? ` e ${error.tokenUsage.thoughtTokens.toLocaleString('pt-BR')} de raciocínio`
                  : ''}. `
            : ''}`
          + `Nova tentativa ${attempt + 1}/${maxAttempts} em ${(delayMs / 1000).toFixed(1)}s.`
        );
        await waitMilliseconds(delayMs);
      } finally {
        clearTimeout(timeoutId);
        lastVertexRequestFinishedAt = Date.now();
      }
    }

    throw new Error(`Falha inesperada ao processar ${label}.`);
}

function normalizeMarkdownTransportNewlines(value) {
    if (typeof value !== 'string' || !value.includes('\\n')) return value;

    const literalNewlineCount = (value.match(/\\n/g) || []).length;
    const hasMarkdownTransportEvidence = /\\n\\n|\\n#{1,6}\s|\\n(?:[*+-]|\d+\.)\s|\\n\|.*\||\|\\n\|/.test(value);

    if (literalNewlineCount < 2 || !hasMarkdownTransportEvidence) return value;
    return value.replace(/\\n/g, '\n');
}

function normalizeMermaidTransportNewlines(value) {
    if (typeof value !== 'string' || !value.includes('\\n')) return value;
    const startsWithMermaidType = /^\s*(?:mindmap|graph\s+(?:TD|TB|BT|LR|RL)|flowchart\s+(?:TD|TB|BT|LR|RL))\b/i.test(value);
    return startsWithMermaidType ? value.replace(/\\n/g, '\n') : value;
}

function normalizeContentTransportArtifacts(data, label) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.sections)) return data;

    data.sections.forEach((section, index) => {
        const original = section.content_markdown;
        const normalized = normalizeMarkdownTransportNewlines(original);
        if (normalized !== original) {
            section.content_markdown = normalized;
            console.warn(`⚠️ Artefato de transporte \\n corrigido em content_markdown (${label}, seção ${index + 1}).`);
        }

        const originalMermaid = section.mermaid_mindmap;
        const normalizedMermaid = normalizeMermaidTransportNewlines(originalMermaid);
        if (normalizedMermaid !== originalMermaid) {
            section.mermaid_mindmap = normalizedMermaid;
            console.warn(`⚠️ Artefato de transporte \\n corrigido em mermaid_mindmap (${label}, seção ${index + 1}).`);
        }
    });

    return data;
}

function parseModelJsonResponse(response, label) {
    try {
        return normalizeContentTransportArtifacts(JSON.parse(response.text), label);
    } catch (error) {
        throw new Error(`Resposta inválida do Gemini em ${label}: JSON não pôde ser parseado. ${error.message}`);
    }
}

function buildLeiautBlockPrompt(block, context) {
    const outline = getMarkdownOutline(block) || '(sem cabeçalhos de nível 1 a 3)';
    const expectedSectionTitles = getLevelTwoHeadingTitles(block);
    const visualPromptInstruction = context.visualPromptInstruction
        ? `\n${context.visualPromptInstruction}\n`
        : '';

    return `Metadados do arquivo completo:
Nome original: ${context.fileName}
Título canônico: ${context.topicTitle}
Disciplina inferida: ${context.discipline}
topic_id canônico: ${context.topicId}

Estrutura de cabeçalhos deste bloco (sem criar conteúdo ausente):
${outline}

Este é o bloco ${context.blockIndex} de ${context.totalBlocks} do mesmo arquivo.
Transforme SOMENTE o conteúdo deste bloco em JSON estruturado de estudo.
Use exatamente os metadados canônicos informados acima em topic_title, discipline e topic_id.
Não repita conteúdo de outros blocos, não antecipe blocos seguintes e não omita conteúdo deste bloco.
Retorne em sections apenas as seções derivadas deste bloco. Os section_id serão renumerados após a consolidação.
${expectedSectionTitles.length > 0
    ? `Retorne exatamente ${expectedSectionTitles.length} seção(ões), nesta ordem, correspondentes exclusivamente aos títulos ##: ${expectedSectionTitles.join(' | ')}. Cabeçalhos ### e inferiores permanecem dentro de content_markdown da seção ## pai.`
    : 'Este bloco não possui título ##; não invente subdivisões além da estrutura necessária para transportar o conteúdo.'}

Conteúdo do bloco:

${visualPromptInstruction}

${block}`;
}

function mergeLeiautBlockData(blockData, context) {
    const sections = [];

    blockData.forEach((data, index) => {
        if (!data || typeof data !== 'object' || !Array.isArray(data.sections)) {
            throw new Error(`Resposta inválida do Gemini no bloco ${index + 1}: campo sections ausente ou inválido.`);
        }
        if (data.sections.length === 0) {
            throw new Error(`Resposta inválida do Gemini no bloco ${index + 1}: nenhuma seção foi retornada.`);
        }
        sections.push(...data.sections);
    });

    const mergedData = {
        topic_id: context.topicId,
        topic_title: context.topicTitle,
        discipline: context.discipline,
        sections
    };

    renumberSectionIds(mergedData);
    return mergedData;
}

async function generateLeiautData(markdownContent, inputPath, options) {
    const sourceBlocks = options.forceSingle
        ? [markdownContent]
        : splitContentIntoBlocks(markdownContent, options.blockInputTokens, {
            maxStructuralUnitTokens: options.maxSectionTokens
        });
    const context = {
        fileName: path.basename(inputPath),
        topicTitle: getCanonicalTopicTitle(markdownContent, titleFromFileName(inputPath)),
        discipline: inferDiscipline(markdownContent, inputPath),
        visualPromptInstruction: buildVisualPromptInstruction(options.visualManifestContext),
    };
    context.topicId = slugify(context.topicTitle, 'topico-indefinido');

    if (sourceBlocks.length === 1) {
        const label = 'arquivo completo';
        const response = await generateStructuredContent(
            options.modelName,
            buildLeiautBlockPrompt(markdownContent, {
                ...context,
                blockIndex: 1,
                totalBlocks: 1
            }),
            options.timeoutMs,
            label,
            options
        );
        const parsedFile = parseModelJsonResponse(response, label);
        canonicalizeSectionTitlesFromSource(parsedFile, markdownContent);
        assertSectionStructureMatchesSource(parsedFile, markdownContent);
        return parsedFile;
    }

    console.log(
        `📦 Processamento fracionado: ${sourceBlocks.length} blocos; `
        + `alvo de ~${options.blockInputTokens.toLocaleString('pt-BR')} tokens `
        + `e teto de ~${options.maxSectionTokens.toLocaleString('pt-BR')} para seção ## indivisível.`
    );
    const blockData = [];

    for (let index = 0; index < sourceBlocks.length; index += 1) {
        const blockNumber = index + 1;
        const label = `bloco ${blockNumber}/${sourceBlocks.length}`;
        const response = await generateStructuredContent(
            options.modelName,
            buildLeiautBlockPrompt(sourceBlocks[index], {
                ...context,
                blockIndex: blockNumber,
                totalBlocks: sourceBlocks.length
            }),
            options.timeoutMs,
            label,
            options
        );
        const parsedBlock = parseModelJsonResponse(response, label);
        canonicalizeSectionTitlesFromSource(parsedBlock, sourceBlocks[index]);
        assertSectionStructureMatchesSource(parsedBlock, sourceBlocks[index]);
        blockData.push(parsedBlock);
    }

    console.log(`✅ ${sourceBlocks.length} blocos processados; consolidando o JSON em memória.`);
    return mergeLeiautBlockData(blockData, context);
}

function cleanMermaidInSections(data, verbose = true) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.sections)) return data;

    const shouldPrintDetails = verbose && data.sections.length <= 20;
    console.log("\n🔍 Validando e limpando código Mermaid.js...");

    data.sections.forEach((section, index) => {
        const originalMermaid = section.mermaid_mindmap;
        section.mermaid_mindmap = cleanMermaidCode(originalMermaid, {
            title: section.title,
            content_markdown: section.content_markdown
        });

        if (shouldPrintDetails) {
            console.log(`\n--- Seção ${index + 1}: ${section.title} ---`);
            console.log(`ID: ${section.section_id}`);
            const isMindmap = section.mermaid_mindmap.trim().startsWith('mindmap');
            console.log(`Mermaid Check (${isMindmap ? 'Mindmap' : 'Graph'}):`);
            console.log(section.mermaid_mindmap);
            console.log("------------------------------------------");
        }
    });

    if (!shouldPrintDetails) {
        console.log(`✅ Mermaid limpo em ${data.sections.length} seções. Detalhes omitidos para evitar log excessivo.`);
    }

    return data;
}

function renumberSectionIds(data) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.sections)) return data;

    data.sections.forEach((section, index) => {
        const secNum = String(index + 1).padStart(2, '0');
        section.section_id = `${data.topic_id}-sec-${secNum}`;
    });

    return data;
}

// 2. Define o Schema JSON exato conforme especificação LEIAUT
const responseSchema = {
  type: Type.OBJECT,
  properties: {
    topic_id: { type: Type.STRING },
    topic_title: { type: Type.STRING },
    discipline: { type: Type.STRING },
    sections: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          section_id: { type: Type.STRING },
          title: { type: Type.STRING },
          content_markdown: { type: Type.STRING },
          callouts: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                type: { type: Type.STRING }, // "warning", "info", "tip"
                title: { type: Type.STRING },
                text: { type: Type.STRING }
              },
              required: ["type", "title", "text"]
            }
          },
          mnemonics: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                key: { type: Type.STRING },
                meaning: { type: Type.STRING },
                description: { type: Type.STRING }
              },
              required: ["key", "meaning", "description"]
            }
          },
          flashcards: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                question: { type: Type.STRING },
                answer: { type: Type.STRING }
              },
              required: ["question", "answer"]
            }
          },
          mermaid_mindmap: { type: Type.STRING }
        },
        required: ["section_id", "title", "content_markdown", "callouts", "mnemonics", "flashcards", "mermaid_mindmap"]
      }
    }
  },
  required: ["topic_id", "topic_title", "discipline", "sections"]
};

// 3. Prompt Mestre (Instrução do Sistema) - Refinado para Mermaid e API PRO Resumos
const systemInstruction = `Você é um Engenheiro Pedagógico e Especialista em Memorização e Aprendizado Acelerado focado em Concursos Públicos de Alto Nível.
Sua missão é transformar um material de estudo em formato Markdown (.md) em uma estrutura JSON altamente didática.

Regras de Transformação:
1. Disciplina: Use primeiro o nome original do arquivo, quando ele declarar claramente uma disciplina. Confirme pelo título, cabeçalhos e texto e associe o nome canônico ao campo 'discipline'.
   - NÃO force uma disciplina jurídica quando o arquivo tratar de outra área, como Contabilidade, Administração, Economia, Português, Matemática ou Informática.
   - Use o nome claro da disciplina encontrada no próprio arquivo. Exemplos ilustrativos: "Contabilidade", "Direito Constitucional", "Administração Financeira e Orçamentária".
   - "Orçamento Público" é um tema da disciplina "Administração Financeira e Orçamentária"; use o nome da disciplina, não o recorte temático.
   - Se a disciplina não estiver clara no nome nem no conteúdo, use "Geral". Nunca use exemplos do prompt ou de documentação como se fossem a disciplina do arquivo.
2. IDs Padronizados:
   - topic_id: Identificador único em minúsculas e sem acentos, substituindo espaços ou caracteres especiais por hífens (-). NUNCA use underscores (_). Exemplo ilustrativo: "topico-principal"
   - section_id: Identificador único para cada seção. Deve ser obrigatoriamente prefixado com o 'topic_id' seguido de "-sec-NN" onde NN é o número sequencial de dois dígitos (01, 02, etc.). NUNCA use underscores (_). Exemplo ilustrativo: "topico-principal-sec-01"
3. Divisão em Seções e hierarquia:
   - Quando a fonte contiver cabeçalhos Markdown ##, retorne EXATAMENTE uma seção JSON para cada ##, na mesma ordem.
   - Cabeçalhos ###, #### e inferiores são subtópicos da seção ## pai e devem permanecer dentro de 'content_markdown'. NUNCA os promova a novas seções JSON.
   - Não crie seção para linha de tabela, parágrafo isolado, recurso Mermaid, resumo genérico ou continuação de bloco.
   - Se a fonte não contiver ##, produza somente a menor quantidade de seções necessária, sem seções genéricas ou sem conteúdo.
   - Toda seção retornada deve transportar conteúdo da fonte em 'content_markdown' ou em pelo menos um recurso didático; nunca retorne uma seção totalmente vazia.
   - Títulos usam capitalização editorial: primeira palavra descritiva iniciada em maiúscula e demais palavras em minúsculas. Preserve siglas e abreviações canônicas, como CIDE, ICMS, ISS, NBC TA, TI, RT e FRF.
   - Corrija erros ortográficos evidentes nos títulos. Use "doutrina"; nunca "doutina".
4. Linguagem Didática: Reescreva o conteúdo mantendo o rigor, mas com estilo claro e direto em Markdown.
   - Em 'content_markdown', use quebras de linha reais. NUNCA escreva os dois caracteres literais "\\n" para representar uma quebra.
5. Fidelidade ao Arquivo: Preserve a disciplina, o vocabulário técnico e o recorte temático do arquivo. Não importe conceitos, exemplos, pegadinhas ou mnemônicos de outra disciplina.
6. Callouts: Sempre retorne o campo 'callouts' como array. Identifique pegadinhas (warning), conceitos (info) ou métodos (tip) somente quando estiverem ancorados no conteúdo fornecido. Quando houver base clara, crie de 1 a 3 callouts úteis; se não houver base, retorne [].
   - Use 'warning' somente quando houver risco concreto de erro em prova: exceção ou ressalva, vedação, requisito cumulativo, prazo ou limite numérico, inversão conceitual recorrente, termo técnico facilmente confundível ou entendimento contraintuitivo expressamente sustentado pela fonte.
   - Não use 'warning' apenas para dar ênfase a uma regra geral ou informação importante. Nesses casos, use 'info'. Use 'tip' apenas para método de resolução, memorização ou aplicação prática presente na fonte.
7. Mnemônicos: A análise editorial de mnemônicos já foi realizada no aplicativo de escrita que produziu a fonte. Não censure, descarte nem reavalie mnemônicos explicitamente presentes no material. Preserve-os no 'content_markdown' e transporte-os para 'mnemonics' com os campos 'key', 'meaning' e 'description'. Se a fonte não contiver mnemônico explícito, retorne 'mnemonics': []. Não invente conteúdo ausente da fonte.
8. Flashcards: Crie itens novos de CERTO ou ERRADO em quantidade proporcional aos pontos examináveis distintos da seção, sempre restritos ao conteúdo fornecido.
   - 'question' começa exatamente com "[CERTO/ERRADO]" e apresenta uma assertiva julgável. 'answer' usa "Gabarito: CERTO. Justificativa: ..." ou "Gabarito: ERRADO. Justificativa: ...".
   - Não inclua nome de banca, concurso, cargo, ano, prova, órgão, "questão real", "adaptada" ou equivalentes na pergunta ou na resposta.
   - Não copie nem parafraseie questões de concurso existentes no original; use somente a explicação teórica independente delas.
   - Em conteúdo jurídico, além de CERTO/ERRADO, use "[LETRA DA LEI]" quando a seção contiver a redação expressa de artigo. Cite o artigo na 'question' e use "Texto legal: ..." na 'answer', reproduzindo literalmente somente trecho presente na fonte.
   - Não complete lei, inciso, parágrafo, alternativa, exemplo ou justificativa por memória. Se a redação legal não estiver no material, não gere LETRA DA LEI.
   - Evite testar a mesma afirmação em mais de um cartão.
9. Mapas Mentais (Mermaid.js): Use Mermaid somente quando a relação couber em um diagrama curto e legível.
   - Use APENAS um 'graph TD', 'flowchart TD' ou 'flowchart TB' por seção, com 2 a 6 nós, no máximo 6 relações e no máximo 3 filhos diretos por nó.
   - NÃO use orientação lateral ('LR'/'RL') nem subgraph.
   - Se o conteúdo exigir mais nós, muitas colunas ou uma cadeia longa, retorne 'mermaid_mindmap' como string vazia e organize a comparação/classificação em tabela Markdown no 'content_markdown'; também use flashcards ou callouts quando forem mais adequados.
   - Use rótulos curtos nos nós. Se precisar de texto maior, quebre com <br/> e coloque o rótulo entre aspas: A["Texto maior<br/>em duas linhas"].
   - NÃO use 'pie', 'stateDiagram-v2', 'sequenceDiagram', 'classDiagram' ou múltiplos diagramas no mesmo campo.
   - IMPORTANTE: NÃO use cercas de código (como \`\`\`mermaid). Entregue APENAS o código puro.
   - IMPORTANTE: O código Mermaid deve obrigatoriamente conter quebras de linha (\\n) e recuos de espaços correspondentes para definir a hierarquia. NUNCA gere o diagrama em uma única linha, pois isso gera erros de sintaxe no renderizador.
   - Evite caracteres especiais como parênteses ou aspas dentro dos nós, a menos que use a sintaxe correta (ex: nó["Texto com (parenteses)"]).
   - Certifique-se de que a sintaxe seja 100% válida.`;

/**
 * Limpa e valida o código Mermaid gerado
 */
const MERMAID_ALLOWED_START_PATTERN = /^(mindmap|graph\s+(TD|TB|BT|LR|RL)|flowchart\s+(TD|TB|BT|LR|RL))\b/i;
const MERMAID_KNOWN_START_PATTERN = /^(mindmap|graph\s+(TD|TB|BT|LR|RL)|flowchart\s+(TD|TB|BT|LR|RL)|pie\s+title\b|stateDiagram-v2\b)/i;
const MERMAID_LABEL_WRAP_CHARS = 28;
const MERMAID_MAX_READABLE_NODES = 6;
const MERMAID_COMPACT_GROUP_SIZE = 4;
const MERMAID_MAX_FANOUT = 3;
const MERMAID_MAX_LABEL_PLAIN_CHARS = 44;
const MERMAID_IMPORTANT_PATTERN = /\b(importante|aten[cç][aã]o|cuidado|exce[cç][aã]o|exceto|vedad[ao]s?|proibid[ao]s?|obrigat[oó]ri[ao]s?|limites?|prazos?|requisitos?|regra|art\.?|cf|lrf|stf|n[aã]o|sempre|nunca|deve|podem?|dever[aá])\b|%/i;
const MERMAID_CRITICAL_PATTERN = /\b(n[aã]o|nunca|vedad[ao]s?|proibid[ao]s?|exceto|exce[cç][aã]o|aten[cç][aã]o|cuidado)\b/i;
const MERMAID_PROCESS_PATTERN = /\b(etapa|fase|ciclo|prazo|vig[eê]ncia|elabora[cç][aã]o|aprova[cç][aã]o|execu[cç][aã]o|controle|avalia[cç][aã]o|lan[cç]amento|arrecada[cç][aã]o|recolhimento|empenho|liquida[cç][aã]o|pagamento)\b/i;

function stripMermaidFences(code) {
    return String(code || '')
        .replace(/```mermaid/gi, '')
        .replace(/```/g, '')
        .trim();
}

function splitMermaidDiagrams(code) {
    const lines = stripMermaidFences(code).split(/\r?\n/);
    const diagrams = [];
    let current = [];

    lines.forEach(line => {
        if (MERMAID_KNOWN_START_PATTERN.test(line.trim()) && current.some(existing => existing.trim())) {
            diagrams.push(current.join('\n').trim());
            current = [line];
            return;
        }

        current.push(line);
    });

    if (current.some(line => line.trim())) {
        diagrams.push(current.join('\n').trim());
    }

    return diagrams;
}

function convertPieToMindmap(diagram) {
    const lines = stripMermaidFences(diagram).split(/\r?\n/);
    const titleLine = lines.find(line => /^pie\s+title\b/i.test(line.trim())) || 'pie title Dados';
    const title = titleLine.replace(/^pie\s+title\s*/i, '').trim() || 'Dados';
    const items = lines
        .map(line => line.trim())
        .map(line => line.match(/^"(.+?)"\s*:\s*(.+)$/))
        .filter(Boolean)
        .map(match => `    ${match[1]}: ${match[2]}`);

    if (items.length === 0) return '';

    return [
        'mindmap',
        `  root((${title}))`,
        ...items
    ].join('\n');
}

function sanitizeMermaidLabel(value) {
    const sanitized = String(value || '')
        .replace(/"/g, "'")
        .replace(/\s+/g, ' ')
        .trim();

    return wrapMermaidLabel(sanitized);
}

function wrapMermaidLabel(value, maxChars = MERMAID_LABEL_WRAP_CHARS) {
    const words = String(value || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let currentLine = '';

    words.forEach(word => {
        if (!currentLine) {
            currentLine = word;
            return;
        }

        if (`${currentLine} ${word}`.length <= maxChars) {
            currentLine = `${currentLine} ${word}`;
            return;
        }

        lines.push(currentLine);
        currentLine = word;
    });

    if (currentLine) lines.push(currentLine);
    return lines.join('<br/>');
}

function sanitizeMermaidNodeId(value) {
    let sanitized = String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9_]/g, '_')
        .replace(/^_+|_+$/g, '');

    if (sanitized && !/^[A-Za-z_]/.test(sanitized)) {
        sanitized = `n_${sanitized}`;
    }

    return sanitized || 'inicio';
}

function makeUniqueNodeId(base, usedIds) {
    let candidate = sanitizeMermaidNodeId(base);
    let suffix = 2;

    while (usedIds.has(candidate)) {
        candidate = `${sanitizeMermaidNodeId(base)}_${suffix}`;
        suffix++;
    }

    usedIds.add(candidate);
    return candidate;
}

function sanitizeFlowchartLabels(diagram) {
    return normalizeMermaidNodeIds(normalizeFlowchartDirection(stripMermaidFences(diagram)))
        .split(/\r?\n/)
        .filter(line => !/^\s*(?:classDef|style|linkStyle)\b/i.test(line))
        .map(line => {
            if (/^\s*subgraph\b/i.test(line) || /^\s*(end|class)\b/i.test(line)) {
                return line;
            }

            return line
                .replace(
                    /(^|[^"A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)\s*\["([^"\n]*)"\]/g,
                    (_match, prefix, nodeId, label) => `${prefix}${nodeId}["${sanitizeMermaidLabel(label)}"]`
                )
                .replace(
                    /(^|[^"A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)\s*\[([^\]\n"]+)\]/g,
                    (_match, prefix, nodeId, label) => {
                        const sanitized = sanitizeMermaidLabel(label);
                        const mustQuote = sanitized !== label.trim() || /[\(\):;%]/.test(label);
                        return mustQuote ? `${prefix}${nodeId}["${sanitized}"]` : `${prefix}${nodeId}[${sanitized}]`;
                    }
                )
                .replace(
                    /(^|[^"A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)\s*\(([^()\n]+)\)/g,
                    (_match, prefix, nodeId, label) => `${prefix}${nodeId}["${sanitizeMermaidLabel(label)}"]`
                )
                .replace(
                    /(^|[^"A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)\s*\{([^{}\n]+)\}/g,
                    (_match, prefix, nodeId, label) => `${prefix}${nodeId}["${sanitizeMermaidLabel(label)}"]`
                )
                .replace(
                    /-->\|([^|\n]+)\|/g,
                    (_match, label) => `-->|${sanitizeMermaidLabel(label)}|`
                );
        })
        .join('\n');
}

function normalizeFlowchartDirection(diagram) {
    return stripMermaidFences(diagram).replace(
        /^(graph|flowchart)\s+(LR|RL)\b/i,
        (_match, type) => `${type} TD`
    );
}

function normalizeMermaidNodeIds(diagram) {
    const idMap = new Map();
    const toSafeId = id => {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) return id;
        if (!idMap.has(id)) idMap.set(id, sanitizeMermaidNodeId(id));
        return idMap.get(id);
    };

    let normalized = stripMermaidFences(diagram).replace(
        /(^|\s)([A-Za-z0-9_]+)(?=\s*(?:\[|\(|\{))/gm,
        (_match, prefix, nodeId) => `${prefix}${toSafeId(nodeId)}`
    );

    normalized = normalized.replace(
        /(-->|-.->|==>)\s*([A-Za-z0-9_]+)\b/g,
        (_match, arrow, nodeId) => `${arrow} ${toSafeId(nodeId)}`
    );

    return normalized;
}

function extractMermaidNodeLabels(diagram) {
    const labels = [];
    const cleaned = stripMermaidFences(diagram);
    const labelPattern = /\b[A-Za-z_][A-Za-z0-9_]*\s*(?:\[(?:"([^"\n]*)"|([^\]\n]+))\]|\(([^()\n]+)\)|\{([^{}\n]+)\})/g;
    let match;

    while ((match = labelPattern.exec(cleaned)) !== null) {
        const label = (match[1] || match[2] || match[3] || match[4] || '').trim();
        if (label) labels.push(label);
    }

    return labels;
}

function getMermaidDiagramMetrics(diagram) {
    const cleaned = stripMermaidFences(diagram);
    const labels = extractMermaidNodeLabels(cleaned);
    const uniqueLabels = [];
    const seen = new Set();

    labels.forEach(label => {
        const normalized = label.replace(/<br\/>/g, ' ').replace(/\s+/g, ' ').trim();
        const key = normalized.toLowerCase();
        if (!normalized || seen.has(key)) return;
        seen.add(key);
        uniqueLabels.push(normalized);
    });

    const outgoing = {};
    cleaned.split(/\r?\n/).forEach(line => {
        const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\s*(?:\[[^\]]*\]|\([^)]*\)|\{[^}]*\}))?\s*(?:-->|-.->|==>)/);
        if (match) outgoing[match[1]] = (outgoing[match[1]] || 0) + 1;
    });

    const edgeLabelCount = (cleaned.match(/-->\|[^|\n]+\|/g) || []).length;
    const maxFanout = Math.max(0, ...Object.values(outgoing));
    const maxLabelLength = uniqueLabels.reduce((max, label) => Math.max(max, label.length), 0);

    return {
        labels,
        uniqueLabels,
        uniqueLabelCount: uniqueLabels.length,
        maxFanout,
        maxLabelLength,
        edgeLabelCount,
        hasSubgraph: /^\s*subgraph\b/im.test(cleaned)
    };
}

function isCompactMermaidDiagram(diagram) {
    const cleaned = stripMermaidFences(diagram);
    const metrics = getMermaidDiagramMetrics(cleaned);
    const relationshipCount = (cleaned.match(/(?:-->|---|==>|-\.->|--o|--x)/g) || []).length;

    return /^\s*(?:graph|flowchart)\s+(?:TD|TB)\b/i.test(cleaned)
        && !metrics.hasSubgraph
        && metrics.uniqueLabelCount <= MERMAID_MAX_READABLE_NODES
        && relationshipCount <= 6
        && metrics.maxFanout <= MERMAID_MAX_FANOUT;
}

function hasValidMermaidFlowchartSyntax(diagram) {
    const node = '[A-Za-z_][A-Za-z0-9_]*(?:\\s*(?:\\[[^\\r\\n]*\\]|\\([^()\\r\\n]*\\)|\\{[^\\r\\n]*\\}))?';
    const edge = '(?:-->|---|==>|-\\.->|--o|--x)(?:\\|[^|\\r\\n]+\\|)?';
    const statementPattern = new RegExp(`^\\s*${node}(?:\\s*${edge}\\s*${node})*\\s*;?\\s*$`);
    const classPattern = /^\s*class\s+[A-Za-z_][A-Za-z0-9_,\s]*\s+[A-Za-z_][A-Za-z0-9_-]*;?\s*$/;

    return stripMermaidFences(diagram)
        .split(/\r?\n/)
        .filter(line => line.trim())
        .every(line => {
            const trimmed = line.trim();
            if (/^(?:graph|flowchart)\s+(?:TD|TB)\b/i.test(trimmed)) return true;
            if (classPattern.test(trimmed)) return true;
            if (/^(?:classDef|style|linkStyle)\b/i.test(trimmed)) return false;
            return statementPattern.test(trimmed);
        });
}

function normalizeForHeuristic(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
}

function getMermaidContextText(context = {}) {
    return normalizeForHeuristic([
        context.title,
        context.content_markdown,
        context.contentMarkdown
    ].filter(Boolean).join(' '));
}

function chooseStudyMapVariant(context, metrics) {
    const text = getMermaidContextText(context);
    const joinedLabels = normalizeForHeuristic(metrics.uniqueLabels.join(' '));
    const combined = `${text} ${joinedLabels}`;

    if (/\b(prazo|ciclo|etapa|fase|vigencia|elaboracao|aprovacao|execucao|controle|avaliacao|estagio|ordem|sequencia)\b/.test(combined)) {
        return 'timeline';
    }

    if (/\b(vs|versus|compar|diferenc|classificac|tipos?|modelos?|modalidades?|tradicional|desempenho|incremental|autorizativo|impositivo)\b/.test(combined)) {
        return 'comparison';
    }

    if (/\b(principio|regra|excec|vedac|limite|requisito|proibic|obrigator|renuncia|lrf|cf|art)\b/.test(combined)) {
        return 'rules';
    }

    return 'concept';
}

function getLabelImportance(label) {
    const normalized = String(label || '').replace(/<br\/>/g, ' ');
    if (MERMAID_CRITICAL_PATTERN.test(normalized)) return 'critical';
    if (MERMAID_IMPORTANT_PATTERN.test(normalized)) return 'important';
    if (MERMAID_PROCESS_PATTERN.test(normalized)) return 'process';
    return 'item';
}

function getClassForImportance(importance) {
    if (importance === 'critical') return 'readableCritical';
    if (importance === 'important') return 'readableImportant';
    if (importance === 'process') return 'readableProcess';
    return 'readableItem';
}

function extractMermaidNodes(diagram) {
    const nodes = [];
    const cleaned = stripMermaidFences(diagram);
    const nodePattern = /\b([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[(?:"([^"\n]*)"|([^\]\n]+))\]|\(([^()\n]+)\)|\{([^{}\n]+)\})/g;
    let match;

    while ((match = nodePattern.exec(cleaned)) !== null) {
        const id = match[1];
        const label = (match[2] || match[3] || match[4] || match[5] || '').trim();
        if (id && label && !nodes.some(node => node.id === id)) {
            nodes.push({ id, label });
        }
    }

    return nodes;
}

function appendClassLine(lines, ids, className) {
    const uniqueIds = Array.from(new Set(ids)).filter(Boolean);
    if (uniqueIds.length > 0) {
        lines.push(`    class ${uniqueIds.join(',')} ${className};`);
    }
}

function addImportanceClasses(diagram) {
    const cleaned = stripMermaidFences(diagram);
    if (!cleaned) return cleaned;
    if (/^\s*class\s+/im.test(cleaned)) return cleaned;

    const nodes = extractMermaidNodes(cleaned);
    if (nodes.length === 0) return cleaned;

    const lines = [cleaned];
    const [rootNode, ...otherNodes] = nodes;
    const grouped = {
        readableCritical: [],
        readableImportant: [],
        readableProcess: [],
        readableItem: []
    };

    otherNodes.forEach(node => {
        grouped[getClassForImportance(getLabelImportance(node.label))].push(node.id);
    });

    appendClassLine(lines, [rootNode.id], 'readableRoot');
    appendClassLine(lines, grouped.readableCritical, 'readableCritical');
    appendClassLine(lines, grouped.readableImportant, 'readableImportant');
    appendClassLine(lines, grouped.readableProcess, 'readableProcess');
    appendClassLine(lines, grouped.readableItem, 'readableItem');

    return lines.join('\n');
}

function shouldUseCompactStudyDiagram(diagram) {
    const metrics = getMermaidDiagramMetrics(diagram);
    if (metrics.hasSubgraph) return false;

    return (
        metrics.maxFanout > MERMAID_MAX_FANOUT ||
        metrics.uniqueLabelCount > MERMAID_MAX_READABLE_NODES ||
        metrics.maxLabelLength > MERMAID_MAX_LABEL_PLAIN_CHARS ||
        metrics.edgeLabelCount > 0
    );
}

function addReadableMermaidStyles(diagram) {
    const cleaned = stripMermaidFences(diagram);
    if (!cleaned) return cleaned;

    // O LEIAUT preserva apenas classes semânticas; cores e temas pertencem ao consumidor.
    return addImportanceClasses(cleaned);
}

function compactLargeMermaidDiagram(diagram, context = {}) {
    if (!shouldUseCompactStudyDiagram(diagram)) return addReadableMermaidStyles(diagram);
    if (/(?:-->|---|==>|-\.->|--o|--x)\s*\|[^|\r\n]+\|/.test(diagram)) {
        return addReadableMermaidStyles(diagram);
    }

    const metrics = getMermaidDiagramMetrics(diagram);
    const { uniqueLabels } = metrics;
    if (uniqueLabels.length === 0) return addReadableMermaidStyles(diagram);

    const variant = chooseStudyMapVariant(context, metrics);
    if (variant === 'timeline') return buildTimelineStudyDiagram(uniqueLabels);
    if (variant === 'comparison') return buildComparisonStudyDiagram(uniqueLabels);
    if (variant === 'rules') return buildRulesStudyDiagram(uniqueLabels);
    return buildConceptStudyDiagram(uniqueLabels);
}

function buildConceptStudyDiagram(uniqueLabels) {
    const rootLabel = uniqueLabels[0] || 'Resumo visual';
    const itemLabels = uniqueLabels.slice(1);
    const sourceItems = itemLabels.length > 0 ? itemLabels : uniqueLabels;
    const groups = [];

    for (let index = 0; index < sourceItems.length; index += MERMAID_COMPACT_GROUP_SIZE) {
        groups.push(sourceItems.slice(index, index + MERMAID_COMPACT_GROUP_SIZE));
    }

    const lines = [
        'flowchart TB',
        `    resumo["${sanitizeMermaidLabel(rootLabel)}"]`
    ];
    const itemIds = [];
    const groupAnchorIds = [];

    groups.forEach((group, index) => {
        const groupId = `bloco_${index + 1}`;
        const groupAnchorId = `grupo_${index + 1}`;
        groupAnchorIds.push(groupAnchorId);
        lines.push(`    subgraph ${groupId}["Bloco ${index + 1}"]`);
        lines.push('        direction TB');
        lines.push(`        ${groupAnchorId}["Grupo temático ${index + 1}"]`);
        group.forEach((label, itemIndex) => {
            const itemId = `item_${index + 1}_${itemIndex + 1}`;
            itemIds.push(itemId);
            lines.push(`        ${itemId}["${sanitizeMermaidLabel(label)}"]`);
            lines.push(`        ${groupAnchorId} -->|inclui| ${itemId}`);
        });
        lines.push('    end');
        if (group.length > 0) lines.push(`    resumo -->|organiza| ${groupAnchorId}`);
    });

    lines.push('    class resumo readableRoot;');
    appendClassLine(lines, groupAnchorIds, 'readableAccent');
    if (itemIds.length > 0) {
        appendGroupedImportanceClasses(lines, itemIds, sourceItems);
    }

    return addReadableMermaidStyles(lines.join('\n'));
}

function buildTimelineStudyDiagram(uniqueLabels) {
    const rootLabel = uniqueLabels[0] || 'Fluxo de estudo';
    const steps = uniqueLabels.slice(1);
    const sourceSteps = steps.length > 0 ? steps : uniqueLabels;
    const stepIds = [];
    const lines = [
        'flowchart TB',
        `    inicio["${sanitizeMermaidLabel(rootLabel)}"]`
    ];

    sourceSteps.forEach((label, index) => {
        const stepId = `etapa_${index + 1}`;
        stepIds.push(stepId);
        lines.push(`    ${stepId}["${String(index + 1).padStart(2, '0')} · ${sanitizeMermaidLabel(label)}"]`);
        lines.push(index === 0 ? `    inicio -->|inicia em| ${stepId}` : `    etapa_${index} -->|prossegue para| ${stepId}`);
    });

    lines.push('    class inicio readableRoot;');
    appendClassLine(lines, stepIds, 'readableProcess');
    return addReadableMermaidStyles(lines.join('\n'));
}

function buildComparisonStudyDiagram(uniqueLabels) {
    const rootLabel = uniqueLabels[0] || 'Comparação';
    const sourceItems = uniqueLabels.slice(1);
    const midpoint = Math.ceil(sourceItems.length / 2);
    const columns = [
        sourceItems.slice(0, midpoint),
        sourceItems.slice(midpoint)
    ].filter(column => column.length > 0);
    const itemIds = [];
    const columnAnchorIds = [];
    const lines = [
        'flowchart TB',
        `    comparacao["${sanitizeMermaidLabel(rootLabel)}"]`
    ];

    columns.forEach((column, columnIndex) => {
        const groupId = `comparativo_${columnIndex + 1}`;
        const columnAnchorId = `eixo_${columnIndex + 1}`;
        columnAnchorIds.push(columnAnchorId);
        lines.push(`    subgraph ${groupId}["Eixo ${columnIndex + 1}"]`);
        lines.push('        direction TB');
        lines.push(`        ${columnAnchorId}["Eixo comparativo ${columnIndex + 1}"]`);
        column.forEach((label, itemIndex) => {
            const itemId = `cmp_${columnIndex + 1}_${itemIndex + 1}`;
            itemIds.push(itemId);
            lines.push(`        ${itemId}["${sanitizeMermaidLabel(label)}"]`);
            lines.push(`        ${columnAnchorId} -->|reúne| ${itemId}`);
        });
        lines.push('    end');
        lines.push(`    comparacao -->|compara por| ${columnAnchorId}`);
    });

    lines.push('    class comparacao readableRoot;');
    appendClassLine(lines, columnAnchorIds, 'readableAccent');
    appendGroupedImportanceClasses(lines, itemIds, sourceItems);
    return addReadableMermaidStyles(lines.join('\n'));
}

function buildRulesStudyDiagram(uniqueLabels) {
    const rootLabel = uniqueLabels[0] || 'Regras e exceções';
    const items = uniqueLabels.slice(1);
    const criticalItems = items.filter(label => getLabelImportance(label) === 'critical');
    const importantItems = items.filter(label => getLabelImportance(label) === 'important');
    const normalItems = items.filter(label => !criticalItems.includes(label) && !importantItems.includes(label));
    const groups = [
        { id: 'criticos', title: 'Atenção / Exceções', items: criticalItems, className: 'readableCritical' },
        { id: 'importantes', title: 'Pontos Importantes', items: importantItems, className: 'readableImportant' },
        { id: 'gerais', title: 'Conceitos de Apoio', items: normalItems, className: 'readableItem' }
    ].filter(group => group.items.length > 0);
    const lines = [
        'flowchart TB',
        `    regras["${sanitizeMermaidLabel(rootLabel)}"]`
    ];

    lines.push('    class regras readableRoot;');
    groups.forEach(group => {
        const ids = [];
        const groupAnchorId = `${group.id}_grupo`;
        lines.push(`    subgraph ${group.id}["${group.title}"]`);
        lines.push('        direction TB');
        lines.push(`        ${groupAnchorId}["${sanitizeMermaidLabel(group.title)}"]`);
        group.items.forEach((label, index) => {
            const itemId = `${group.id}_${index + 1}`;
            ids.push(itemId);
            lines.push(`        ${itemId}["${sanitizeMermaidLabel(label)}"]`);
            lines.push(`        ${groupAnchorId} -->|destaca| ${itemId}`);
        });
        lines.push('    end');
        lines.push(`    regras -->|organiza como| ${groupAnchorId}`);
        appendClassLine(lines, [groupAnchorId], 'readableAccent');
        appendClassLine(lines, ids, group.className);
    });

    return addReadableMermaidStyles(lines.join('\n'));
}

function appendGroupedImportanceClasses(lines, ids, labels) {
    const grouped = {
        readableCritical: [],
        readableImportant: [],
        readableProcess: [],
        readableItem: []
    };

    ids.forEach((id, index) => {
        grouped[getClassForImportance(getLabelImportance(labels[index]))].push(id);
    });

    appendClassLine(lines, grouped.readableCritical, 'readableCritical');
    appendClassLine(lines, grouped.readableImportant, 'readableImportant');
    appendClassLine(lines, grouped.readableProcess, 'readableProcess');
    appendClassLine(lines, grouped.readableItem, 'readableItem');
}

function convertMindmapToFlowchart(diagram) {
    const lines = stripMermaidFences(diagram).split(/\r?\n/);
    const contentLines = lines.slice(1).filter(line => line.trim());
    const stack = [];
    const edges = [];
    const declarations = [];
    const usedIds = new Set();

    contentLines.forEach((line, index) => {
        const indent = line.match(/^\s*/)?.[0].length || 0;
        let label = line.trim();

        label = label
            .replace(/^root\s*\(\((.*)\)\)\s*$/i, '$1')
            .replace(/^\(\((.*)\)\)\s*$/, '$1')
            .replace(/^\((.*)\)\s*$/, '$1')
            .trim();

        if (!label) return;

        const nodeId = makeUniqueNodeId(`${label}_${index}`, usedIds);
        declarations.push(`    ${nodeId}["${sanitizeMermaidLabel(label)}"]`);

        while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
            stack.pop();
        }

        if (stack.length > 0) {
            edges.push(`    ${stack[stack.length - 1].id} --> ${nodeId}`);
        }

        stack.push({ indent, id: nodeId });
    });

    if (declarations.length === 0) return '';
    return compactLargeMermaidDiagram(['flowchart TD', ...declarations, ...edges].join('\n'));
}

function convertStateDiagramToFlowchart(diagram) {
    const lines = stripMermaidFences(diagram).split(/\r?\n/);
    const edges = [];

    lines.forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || /^stateDiagram-v2\b/i.test(trimmed)) return;

        const match = trimmed.match(/^(.+?)\s*-->\s*(.+?)(?:\s*:\s*(.+))?$/);
        if (!match) return;

        const fromLabel = match[1].trim();
        const toLabel = match[2].trim();
        const label = (match[3] || '').trim();
        const fromId = sanitizeMermaidNodeId(fromLabel === '[*]' ? 'inicio' : fromLabel);
        const toId = sanitizeMermaidNodeId(toLabel === '[*]' ? 'fim' : toLabel);
        const fromText = fromLabel === '[*]' ? 'Início' : fromLabel.replace(/_/g, ' ');
        const toText = toLabel === '[*]' ? 'Fim' : toLabel.replace(/_/g, ' ');
        const edgeLabel = label ? `|${label}|` : '';

        edges.push(`    ${fromId}["${fromText}"] -->${edgeLabel} ${toId}["${toText}"]`);
    });

    if (edges.length === 0) return '';
    return compactLargeMermaidDiagram(['flowchart TD', ...edges].join('\n'));
}

function normalizeMermaidDiagram(diagram, context = {}) {
    const cleaned = stripMermaidFences(diagram);
    const firstLine = cleaned.split(/\r?\n/).find(line => line.trim())?.trim() || '';

    if (/^mindmap\b/i.test(firstLine)) return convertMindmapToFlowchart(cleaned);
    if (/^(graph|flowchart)\s+(TD|TB|BT|LR|RL)\b/i.test(firstLine)) return compactLargeMermaidDiagram(sanitizeFlowchartLabels(cleaned), context);
    if (/^pie\s+title\b/i.test(firstLine)) return compactLargeMermaidDiagram(convertMindmapToFlowchart(convertPieToMindmap(cleaned)), context);
    if (/^stateDiagram-v2\b/i.test(firstLine)) return convertStateDiagramToFlowchart(cleaned);

    return '';
}

function cleanMermaidCode(code, context = {}) {
    if (!code) return "";
    const diagrams = splitMermaidDiagrams(code);
    if (diagrams.length === 0) return "";

    const preferred = diagrams.find(diagram => MERMAID_ALLOWED_START_PATTERN.test(diagram.trim().split(/\r?\n/)[0] || ''));
    const selected = preferred || diagrams[0];
    const normalized = normalizeMermaidDiagram(selected, context);
    return isCompactMermaidDiagram(normalized) && hasValidMermaidFlowchartSyntax(normalized)
        ? normalized
        : '';
}

function collectPostGenerationDiagnostics(data) {
    const diagnostics = [];
    const add = (level, code, message) => diagnostics.push({ level, code, message });

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        add('ERROR', 'ROOT_INVALID', 'A resposta raiz não é um objeto JSON.');
        return diagnostics;
    }

    ['topic_id', 'topic_title', 'discipline'].forEach(field => {
        if (typeof data[field] !== 'string' || !data[field].trim()) {
            add('ERROR', 'ROOT_FIELD_EMPTY', `Campo raiz '${field}' ausente ou vazio.`);
        }
    });

    if (!Array.isArray(data.sections)) {
        add('ERROR', 'SECTIONS_INVALID', "Campo raiz 'sections' ausente ou não é um array.");
        return diagnostics;
    }
    if (data.sections.length === 0) {
        add('WARN', 'SECTIONS_EMPTY', 'Nenhuma seção foi retornada pelo modelo.');
    }

    const seenSectionIds = new Set();
    const seenSectionTitles = new Set();
    data.sections.forEach((section, index) => {
        const position = index + 1;
        const title = typeof section?.title === 'string' && section.title.trim()
            ? section.title.trim()
            : `Seção ${position}`;
        const prefix = `Seção ${position} ('${title}')`;

        if (!section || typeof section !== 'object' || Array.isArray(section)) {
            add('ERROR', 'SECTION_INVALID', `${prefix}: valor não é um objeto.`);
            return;
        }

        if (typeof section.section_id !== 'string' || !section.section_id.trim()) {
            add('ERROR', 'SECTION_ID_EMPTY', `${prefix}: 'section_id' ausente ou vazio.`);
        } else if (seenSectionIds.has(section.section_id)) {
            add('ERROR', 'SECTION_ID_DUPLICATE', `${prefix}: section_id duplicado: ${section.section_id}.`);
        } else {
            seenSectionIds.add(section.section_id);
        }

        if (typeof section.title !== 'string' || !section.title.trim()) {
            add('WARN', 'SECTION_TITLE_EMPTY', `${prefix}: 'title' ausente ou vazio.`);
        } else {
            const titleKey = normalizeTitleKey(section.title);
            if (seenSectionTitles.has(titleKey)) {
                add('ERROR', 'SECTION_TITLE_DUPLICATE', `${prefix}: título de seção duplicado.`);
            } else {
                seenSectionTitles.add(titleKey);
            }
            if (isPredominantlyUppercaseTitle(section.title)) {
                add('ERROR', 'SECTION_TITLE_UPPERCASE', `${prefix}: título predominantemente em maiúsculas.`);
            }
        }
        if (typeof section.content_markdown !== 'string') {
            add('ERROR', 'CONTENT_INVALID', `${prefix}: 'content_markdown' não é string.`);
        } else if (!section.content_markdown.trim()) {
            add('WARN', 'CONTENT_EMPTY', `${prefix}: sem 'content_markdown'.`);
        }

        ['callouts', 'mnemonics', 'flashcards'].forEach(field => {
            if (!Array.isArray(section[field])) {
                add('ERROR', 'ARRAY_FIELD_INVALID', `${prefix}: '${field}' não é um array.`);
            }
        });
        if (Array.isArray(section.callouts) && section.callouts.length === 0) {
            add('INFO', 'CALLOUTS_EMPTY', `${prefix}: sem callouts (opcional).`);
        }
        if (Array.isArray(section.flashcards) && section.flashcards.length === 0) {
            add('WARN', 'FLASHCARDS_EMPTY', `${prefix}: sem flashcards.`);
        }
        if (!sectionHasUsefulContent(section)) {
            add('ERROR', 'SECTION_EMPTY', `${prefix}: sem conteúdo nem recurso didático.`);
        }

        if (Array.isArray(section.mnemonics)) {
            section.mnemonics.forEach((mnemonic, mnemonicIndex) => {
                const complete = mnemonic
                    && typeof mnemonic === 'object'
                    && ['key', 'meaning', 'description'].every(field => (
                        typeof mnemonic[field] === 'string' && mnemonic[field].trim()
                    ));
                if (!complete) {
                    add('ERROR', 'MNEMONIC_STRUCTURE', `${prefix}: mnemonics[${mnemonicIndex}] sem key, meaning ou description válidos.`);
                }
            });
        }

        if (typeof section.mermaid_mindmap !== 'string') {
            add('ERROR', 'MERMAID_INVALID_TYPE', `${prefix}: 'mermaid_mindmap' não é string.`);
        } else if (!section.mermaid_mindmap.trim()) {
            add('INFO', 'MERMAID_EMPTY', `${prefix}: sem mermaid_mindmap (opcional).`);
        } else {
            try {
                const cleaned = cleanMermaidCode(section.mermaid_mindmap, {
                    title: section.title,
                    content_markdown: section.content_markdown
                });
                if (!cleaned) {
                    add('ERROR', 'MERMAID_REJECTED', `${prefix}: Mermaid não seria aceito pelo limpador legado.`);
                } else if (cleaned !== section.mermaid_mindmap.trim()) {
                    add('WARN', 'MERMAID_NORMALIZATION_NEEDED', `${prefix}: Mermaid exigiria normalização; o JSON foi preservado sem alterações.`);
                }
            } catch (error) {
                add('ERROR', 'MERMAID_DIAGNOSTIC_FAILED', `${prefix}: falha ao diagnosticar Mermaid: ${error.message}`);
            }
        }
    });

    try {
        validateTopicFlashcards(data);
    } catch (error) {
        if (Array.isArray(error?.details)) {
            error.details.forEach(detail => add('ERROR', 'FLASHCARD_QUALITY', detail));
        } else {
            add('ERROR', 'FLASHCARD_DIAGNOSTIC_FAILED', `Falha ao diagnosticar flashcards: ${error.message}`);
        }
    }

    return diagnostics;
}

function formatDiagnosticsLog(diagnostics, context = {}) {
    const counts = diagnostics.reduce((summary, diagnostic) => {
        summary[diagnostic.level] = (summary[diagnostic.level] || 0) + 1;
        return summary;
    }, { ERROR: 0, WARN: 0, INFO: 0 });
    const lines = [
        'LEIAUT - Diagnóstico pós-geração',
        `Gerado em: ${context.generatedAt || new Date().toISOString()}`,
        `Arquivo JSON: ${context.outputPath || '(não informado)'}`,
        'Observação: o JSON foi gravado antes deste diagnóstico e não foi alterado.',
        '',
        `Resumo: ${counts.ERROR} erro(s), ${counts.WARN} aviso(s), ${counts.INFO} informação(ões).`,
        ''
    ];

    if (diagnostics.length === 0) {
        lines.push('[OK] Nenhum diagnóstico encontrado.');
    } else {
        diagnostics.forEach((diagnostic, index) => {
            const message = String(diagnostic.message || '').replace(/\s+/g, ' ').trim();
            lines.push(`${String(index + 1).padStart(3, '0')}. [${diagnostic.level}] [${diagnostic.code}] ${message}`);
        });
    }

    return { text: `${lines.join('\n')}\n`, counts };
}

function writePostGenerationDiagnostics(data, outputPath) {
    const diagnostics = collectPostGenerationDiagnostics(data);
    const logPath = outputPath.replace(/\.json$/i, '_diagnostico.log');
    const formatted = formatDiagnosticsLog(diagnostics, { outputPath });
    fs.writeFileSync(logPath, formatted.text, 'utf-8');
    return { diagnostics, logPath, counts: formatted.counts };
}

/**
 * Valida e normaliza o JSON gerado
 */
function validateAndNormalizeOutput(data, sourceFilePath = '') {
    if (!data || typeof data !== 'object') {
        console.warn("⚠️ Dados inválidos recebidos para validação.");
        return data;
    }

    console.log("\n⚙️ Iniciando validação e normalização pós-processamento...");
    const originalDocumentTitle = getOriginalDocumentTitleFromFile(sourceFilePath);
    const titleContext = getStudyContentContext({
        ...data,
        topic_title: originalDocumentTitle ?? data.topic_title,
    });
    normalizeKnownTyposDeep(data);

    // 1. Validar e normalizar topic_id
    if (!data.topic_id) {
        console.warn("⚠️ Campo 'topic_id' ausente ou vazio. Gerando um temporário.");
        data.topic_id = "topico-indefinido";
    }
    const originalTopicId = data.topic_id;
    // Substitui underscores por hífens e garante minúsculas e sem caracteres especiais não permitidos
    data.topic_id = data.topic_id.toLowerCase().replace(/_/g, '-').replace(/[^a-z0-9\-]/g, '');
    if (originalTopicId !== data.topic_id) {
        console.log(`🔧 topic_id normalizado: "${originalTopicId}" -> "${data.topic_id}"`);
    }

    // 2. Validar e normalizar discipline sem restringir o projeto a disciplinas jurídicas.
    const disciplineFromFileName = inferDisciplineFromFileName(sourceFilePath);
    const disciplineAliases = new Map([
        ['orcamento publico', 'Administração Financeira e Orçamentária']
    ]);

    if (disciplineFromFileName) {
        if (data.discipline !== disciplineFromFileName) {
            console.log(`🔧 discipline ajustada pelo nome do arquivo: "${data.discipline || 'vazia'}" -> "${disciplineFromFileName}"`);
        }
        data.discipline = disciplineFromFileName;
    } else if (!data.discipline) {
        console.warn("⚠️ Campo 'discipline' ausente ou vazio. Definindo como 'Geral'.");
        data.discipline = "Geral";
    } else {
        const normalizedDiscipline = String(data.discipline).trim().replace(/\s+/g, ' ');
        // Corrige apenas variações de caixa/espaçamento em disciplinas conhecidas; desconhecidas são preservadas.
        const normalizedSearch = normalizeDisciplineSearchText(normalizedDiscipline);
        const found = canonicalDisciplines.find(d => normalizeDisciplineSearchText(d) === normalizedSearch);
        if (found) {
            data.discipline = found;
        } else if (disciplineAliases.has(normalizedSearch)) {
            data.discipline = disciplineAliases.get(normalizedSearch);
        } else {
            data.discipline = normalizedDiscipline;
        }
    }

    // 3. Validar topic_title
    if (originalDocumentTitle) {
        data.topic_title = originalDocumentTitle;
    } else if (!data.topic_title) {
        console.warn("⚠️ Campo 'topic_title' ausente ou vazio.");
        data.topic_title = "Título Indefinido";
    } else {
        data.topic_title = normalizeStudyTitle(data.topic_title, titleContext);
    }

    // 4. Validar e normalizar sections
    if (!Array.isArray(data.sections)) {
        console.warn("⚠️ Campo 'sections' ausente ou não é um array. Inicializando como vazio.");
        data.sections = [];
    }

    data.sections.forEach((section, index) => {
        const secNum = String(index + 1).padStart(2, '0');
        
        // 4.1. Validar e normalizar section_id
        if (!section.section_id) {
            console.warn(`⚠️ Seção ${index + 1} sem 'section_id'. Gerando a partir do topic_id.`);
            section.section_id = `${data.topic_id}-sec-${secNum}`;
        } else {
            const originalSecId = section.section_id;
            // Remove underscores, força minúsculas
            let secId = section.section_id.toLowerCase().replace(/_/g, '-').replace(/[^a-z0-9\-]/g, '');
            
            const expectedPrefix = `${data.topic_id}-`;
            if (!secId.startsWith(expectedPrefix)) {
                // Remove prefixos incorretos ou formata
                if (secId.includes('sec-')) {
                    const match = secId.match(/sec-\d+/);
                    const suffix = match ? match[0] : `sec-${secNum}`;
                    secId = `${data.topic_id}-${suffix}`;
                } else {
                    secId = `${data.topic_id}-${secId}`;
                }
            }

            // Garante que tenha o sufixo -sec-NN
            if (!secId.includes('-sec-')) {
                secId = `${secId}-sec-${secNum}`;
            }
            
            section.section_id = secId;
            if (originalSecId !== section.section_id) {
                console.log(`🔧 section_id normalizado: "${originalSecId}" -> "${section.section_id}"`);
            }
        }

        // 4.2. Validar título da seção
        if (!section.title) {
            console.warn(`⚠️ Seção ${index + 1} sem campo 'title'.`);
            section.title = `Subtópico ${secNum}`;
        } else {
            const originalTitle = section.title;
            section.title = normalizeStudyTitle(section.title, titleContext);
            if (originalTitle !== section.title) {
                console.log(`🔧 título normalizado: "${originalTitle}" -> "${section.title}"`);
            }
        }

        // 4.3. Validar content_markdown
        if (!section.content_markdown) {
            console.warn(`⚠️ Seção ${index + 1} ('${section.title}') sem 'content_markdown'.`);
            section.content_markdown = "";
        } else {
            section.content_markdown = removeOrphanMarkdownHeadings(section.content_markdown);
        }

        // 4.4. Validar callouts
        if (section.callouts) {
            if (!Array.isArray(section.callouts)) {
                console.warn(`⚠️ Campo 'callouts' na seção ${index + 1} não é um array. Convertendo.`);
                section.callouts = [];
            } else if (section.callouts.length === 0) {
                console.log(`ℹ️ Seção ${index + 1} ('${section.title}'): sem callouts (opcional).`);
            } else {
                section.callouts.forEach((callout, cIdx) => {
                    const validTypes = ["warning", "info", "tip"];
                    if (!callout.type) {
                        console.warn(`⚠️ Callout ${cIdx + 1} na seção ${index + 1} sem tipo definido. Ajustando para 'info'.`);
                        callout.type = "info";
                    } else {
                        const originalType = callout.type;
                        callout.type = callout.type.toLowerCase().trim();
                        if (callout.type === "alert" || callout.type === "danger") {
                            callout.type = "warning";
                        } else if (!validTypes.includes(callout.type)) {
                            console.warn(`⚠️ Callout ${cIdx + 1} na seção ${index + 1} com tipo inválido "${originalType}". Ajustando para 'info'.`);
                            callout.type = "info";
                        }
                    }
                    if (!callout.title) callout.title = "Atenção";
                    if (!callout.text) callout.text = "";
                });
            }
        } else {
            console.log(`ℹ️ Seção ${index + 1} ('${section.title}'): sem callouts (opcional).`);
            section.callouts = [];
        }

        // 4.5. Preservar mnemônicos já analisados na etapa de escrita (PYGEM)
        if (!Array.isArray(section.mnemonics)) {
            console.warn(`⚠️ Campo 'mnemonics' na seção ${index + 1} não é um array. Convertendo para array vazio.`);
            section.mnemonics = [];
        } else {
            section.mnemonics = section.mnemonics.filter((mnemonic, mnemonicIndex) => {
                const isValid = mnemonic
                    && typeof mnemonic === 'object'
                    && typeof mnemonic.key === 'string'
                    && mnemonic.key.trim()
                    && typeof mnemonic.meaning === 'string'
                    && mnemonic.meaning.trim()
                    && typeof mnemonic.description === 'string'
                    && mnemonic.description.trim();

                if (!isValid) {
                    console.warn(`⚠️ Mnemônico ${mnemonicIndex + 1} na seção ${index + 1} possui estrutura incompleta e foi descartado.`);
                    return false;
                }

                mnemonic.key = mnemonic.key.trim();
                mnemonic.meaning = mnemonic.meaning.trim();
                mnemonic.description = mnemonic.description.trim();
                return true;
            });
        }

        // 4.6. Validar flashcards
        if (section.flashcards) {
            if (!Array.isArray(section.flashcards)) {
                console.warn(`⚠️ Campo 'flashcards' na seção ${index + 1} não é um array. Convertendo.`);
                section.flashcards = [];
            } else if (section.flashcards.length === 0) {
                console.warn(`⚠️ Seção ${index + 1} ('${section.title}') sem flashcards.`);
            } else {
                section.flashcards.forEach((card, fIdx) => {
                    if (!card.question) card.question = "Pergunta indefinida";
                    if (!card.answer) card.answer = "Resposta indefinida";
                });
            }
        } else {
            console.warn(`⚠️ Seção ${index + 1} ('${section.title}') sem campo 'flashcards'.`);
            section.flashcards = [];
        }

        // 4.7. Validar mermaid_mindmap
        if (!section.mermaid_mindmap) {
            console.warn(`⚠️ Seção ${index + 1} ('${section.title}') sem mermaid_mindmap.`);
            section.mermaid_mindmap = "";
        }
    });

    console.log("✅ Validação e normalização concluídas.");
    renumberSectionIds(data);
    return data;
}

async function processMarkdownFile(inputPath, args, outputBaseDir = process.cwd()) {
    console.log(`📖 Lendo arquivo: ${path.basename(inputPath)}...`);
    const rawMarkdownContent = fs.readFileSync(inputPath, 'utf-8');
    const normalizedMarkdownContent = normalizeInlineTopicMarkers(rawMarkdownContent);
    const markdownContent = removePygemRecoveryMarkers(normalizedMarkdownContent);
    const visualManifestContext = loadVisualManifest({
      inputPath,
      explicitPath: args.visualManifest,
      markdown: markdownContent,
    });
    if (visualManifestContext) {
      console.log(
        `🎨 Manifesto visual carregado: ${path.basename(visualManifestContext.manifestPath)}; `
        + `${visualManifestContext.topics.length} tópico(s) associado(s).`
      );
    }
    if (normalizedMarkdownContent !== rawMarkdownContent) {
      const normalizedMarkers = (rawMarkdownContent.match(/^@@@[ \t]+##(?!#)[ \t]+\S.*$/gm) || []).length;
      console.warn(
        `⚠️  ${normalizedMarkers} marcador(es) de tópico no formato "@@@ ##" `
        + 'foram normalizados em memória para linhas separadas.'
      );
    }
    if (markdownContent !== normalizedMarkdownContent) {
      const removedMarkers = normalizedMarkdownContent.split(/\r?\n/).length
        - markdownContent.split(/\r?\n/).length;
      console.warn(
        `⚠️  ${removedMarkers} marcador(es) técnico(s) exato(s) "Recuperação de bloco" `
        + 'foram ignorados em memória; o conteúdo ao redor foi preservado.'
      );
    }
    const inputValidation = validateMarkdownInput(markdownContent);
    if (!inputValidation.valid) {
      const error = new Error(
        `Markdown de entrada inválido: ${inputValidation.issues.join('; ')}. `
        + 'Corrija ou regenere o arquivo no PYGEM antes de executar o LEIAUT.'
      );
      error.code = 'LEIAUT_INPUT_INVALID';
      throw error;
    }
    const estimatedInputTokens = estimateTokens(markdownContent);
    const headingCount = countMarkdownHeadings(markdownContent);
    const maxInputTokens = getPositiveIntegerEnv('LEIAUT_MAX_INPUT_TOKENS', DEFAULT_LEIAUT_MAX_INPUT_TOKENS);
    const configuredBlockTokens = getPositiveIntegerEnv('LEIAUT_BLOCK_INPUT_TOKENS', DEFAULT_LEIAUT_BLOCK_INPUT_TOKENS);
    const blockInputTokens = Math.min(configuredBlockTokens, maxInputTokens);
    const configuredMaxSectionTokens = getPositiveIntegerEnv(
      'LEIAUT_MAX_SECTION_TOKENS',
      DEFAULT_LEIAUT_MAX_SECTION_TOKENS
    );
    const maxSectionTokens = Math.max(
      blockInputTokens,
      Math.min(configuredMaxSectionTokens, maxInputTokens)
    );
    const timeoutMs = getPositiveIntegerEnv('LEIAUT_TIMEOUT_MS', DEFAULT_LEIAUT_TIMEOUT_MS);
    const maxRetries = Math.min(
      MAX_LEIAUT_RETRIES,
      getNonNegativeIntegerEnv('LEIAUT_MAX_RETRIES', DEFAULT_LEIAUT_MAX_RETRIES)
    );
    const maxTokenRetries = Math.min(
      MAX_LEIAUT_TOKEN_RETRIES,
      getNonNegativeIntegerEnv(
        'LEIAUT_MAX_TOKEN_RETRIES',
        DEFAULT_LEIAUT_MAX_TOKEN_RETRIES
      )
    );
    const retryBaseDelayMs = getPositiveIntegerEnv(
      'LEIAUT_RETRY_BASE_DELAY_MS',
      DEFAULT_LEIAUT_RETRY_BASE_DELAY_MS
    );
    const retryMaxDelayMs = Math.max(
      retryBaseDelayMs,
      getPositiveIntegerEnv('LEIAUT_RETRY_MAX_DELAY_MS', DEFAULT_LEIAUT_RETRY_MAX_DELAY_MS)
    );
    const requestCooldownMs = getNonNegativeIntegerEnv(
      'LEIAUT_REQUEST_COOLDOWN_MS',
      DEFAULT_LEIAUT_REQUEST_COOLDOWN_MS
    );
    const minOutputTokens = Math.min(
      DEFAULT_LEIAUT_MAX_OUTPUT_TOKENS,
      getPositiveIntegerEnv(
        'LEIAUT_MIN_OUTPUT_TOKENS',
        DEFAULT_LEIAUT_MIN_OUTPUT_TOKENS
      )
    );
    const maxOutputTokens = Math.min(
      DEFAULT_LEIAUT_MAX_OUTPUT_TOKENS,
      Math.max(
        minOutputTokens,
        getPositiveIntegerEnv('LEIAUT_MAX_OUTPUT_TOKENS', DEFAULT_LEIAUT_MAX_OUTPUT_TOKENS)
      )
    );
    const outputTokenMultiplier = getPositiveIntegerEnv(
      'LEIAUT_OUTPUT_TOKEN_MULTIPLIER',
      DEFAULT_LEIAUT_OUTPUT_TOKEN_MULTIPLIER
    );
    const outputTokenRetryMultiplier = getPositiveIntegerEnv(
      'LEIAUT_OUTPUT_TOKEN_RETRY_MULTIPLIER',
      DEFAULT_LEIAUT_OUTPUT_TOKEN_RETRY_MULTIPLIER
    );
    const maxOutputTokenRetryMultiplier = Math.max(
      outputTokenRetryMultiplier,
      getPositiveIntegerEnv(
        'LEIAUT_MAX_OUTPUT_TOKEN_RETRY_MULTIPLIER',
        DEFAULT_LEIAUT_MAX_OUTPUT_TOKEN_RETRY_MULTIPLIER
      )
    );
    const thinkingBudget = getNonNegativeIntegerEnv(
      'LEIAUT_THINKING_BUDGET',
      DEFAULT_LEIAUT_THINKING_BUDGET
    );

    console.log(`📊 Tamanho: ${markdownContent.length.toLocaleString('pt-BR')} caracteres, ~${estimatedInputTokens.toLocaleString('pt-BR')} tokens, ${headingCount.toLocaleString('pt-BR')} cabeçalhos.`);

    if (args.noAi) {
      console.log(`🧭 Modo determinístico ativado (${args.splitByTopic ? 'split por tópico ##' : 'arquivo único'}). Nenhuma chamada ao Gemini será feita.`);
      const outputs = buildDeterministicOutputs(markdownContent, inputPath, {
        splitByTopic: args.splitByTopic
      });
      outputs.forEach(output => validateAndNormalizeOutput(output.data, inputPath));
      const plannedOutputPaths = saveDeterministicOutputs(outputs, inputPath, true, outputBaseDir);
      const visualResults = visualManifestContext
        ? outputs.map(output => validateVisualManifestOutput(output.data, markdownContent, visualManifestContext))
        : [];
      if (visualManifestContext && visualResults.some(result => !result.valid)) {
        if (!args.dryRun) {
          visualResults.forEach((result, index) => {
            writeVisualValidationReport(plannedOutputPaths[index], visualManifestContext, result);
          });
        }
        const firstInvalid = visualResults.find(result => !result.valid);
        const error = new Error(
          `Divergência visual obrigatória em ${path.basename(inputPath)}: `
          + firstInvalid.issues.map(issue => `${issue.topic_slug}/${issue.resource}`).join(', ')
        );
        error.code = 'LEIAUT_VISUAL_COMPLIANCE_INVALID';
        error.details = { file: path.basename(inputPath), results: visualResults };
        throw error;
      }
      const outputPaths = saveDeterministicOutputs(outputs, inputPath, args.dryRun, outputBaseDir);
      if (visualManifestContext && !args.dryRun) {
        visualResults.forEach((result, index) => {
          writeVisualValidationReport(outputPaths[index], visualManifestContext, result);
        });
      }
      const totalSections = outputs.reduce((sum, output) => sum + output.data.sections.length, 0);

      if (args.dryRun) {
        console.log(`🧪 Dry run: ${outputs.length} JSON(s) seriam gerados com ${totalSections} seção(ões).`);
      } else {
        console.log(`✅ JSON determinístico gerado: ${outputs.length} arquivo(s), ${totalSections} seção(ões).`);
      }

      printOutputPaths(outputPaths);
      return outputPaths;
    }

    if (args.forceLarge && estimatedInputTokens > maxInputTokens) {
      console.warn('\n⚠️  --force-large ativado: o arquivo excede o limite recomendado e pode demorar, falhar ou gerar JSON incompleto.');
    }

    const vertexConfig = getVertexAIConfig();
    const modelName = vertexConfig.model;
    console.log(`🤖 Enviando ao Gemini (${modelName}) via Vertex AI (Structured Outputs)...`);
    console.log(`☁️ Projeto: ${vertexConfig.project} | Região: ${vertexConfig.location} | API: ${vertexConfig.apiVersion}`);
    console.log(`🔐 Autenticação: ${vertexConfig.credentialsSource}. API Key não é utilizada.`);
    console.log(`⏱️ Timeout da chamada: ${Math.round(timeoutMs / 1000)}s. Se exceder, o processo será interrompido com erro claro.`);
    console.log(
      `🔁 Resiliência: até ${maxRetries} retry(ies) transitório(s) e `
      + `${maxTokenRetries} retry(ies) por MAX_TOKENS, `
      + `backoff base ${(retryBaseDelayMs / 1000).toFixed(1)}s e cooldown ${(requestCooldownMs / 1000).toFixed(1)}s.`
    );
    console.log(
      `🔢 Orçamento de saída: ${minOutputTokens.toLocaleString('pt-BR')}–`
      + `${maxOutputTokens.toLocaleString('pt-BR')} tokens; crescimento `
      + `${outputTokenRetryMultiplier}× após MAX_TOKENS; thinking budget ${thinkingBudget}.`
    );

    let data = await generateLeiautData(markdownContent, inputPath, {
      modelName,
      timeoutMs,
      blockInputTokens,
      maxSectionTokens,
      forceSingle: args.forceLarge,
      maxRetries,
      maxTokenRetries,
      retryBaseDelayMs,
      retryMaxDelayMs,
      requestCooldownMs,
      minOutputTokens,
      maxOutputTokens,
      outputTokenMultiplier,
      outputTokenRetryMultiplier,
      maxOutputTokenRetryMultiplier,
      thinkingBudget,
      visualManifestContext
    });

    // Grava somente depois das normalizações e da validação estrutural contra a fonte.
    data = validateAndNormalizeOutput(data, inputPath);
    canonicalizeSectionTitlesFromSource(data, markdownContent);
    recoverEmptySectionsFromSource(data, markdownContent);
    assertSectionStructureMatchesSource(data, markdownContent);
    cleanMermaidInSections(data, false);
    assertImportableSections(data);

    const outputFileName = `${path.parse(inputPath).name}_processado.json`;
    const outputPath = path.join(outputBaseDir, outputFileName);
    if (visualManifestContext) {
      const visualResult = validateVisualManifestOutput(data, markdownContent, visualManifestContext);
      const visualReportPath = writeVisualValidationReport(outputPath, visualManifestContext, visualResult);
      console.log(
        `🎨 Validação visual: ${visualResult.valid ? 'OK' : 'divergências encontradas'}; `
        + `relatório ${path.basename(visualReportPath)}.`
      );
      if (!visualResult.valid) {
        const error = new Error(
          `Divergência visual obrigatória em ${path.basename(inputPath)}: `
          + visualResult.issues.map(issue => `${issue.topic_slug}/${issue.resource}`).join(', ')
        );
        error.code = 'LEIAUT_VISUAL_COMPLIANCE_INVALID';
        error.details = { file: path.basename(inputPath), result: visualResult };
        throw error;
      }
    }
    fs.writeFileSync(outputPath, JSON.stringify(data, null, 2), 'utf-8');

    console.log("\n✅ JSON gerado, normalizado quanto ao transporte e Mermaid, e salvo antes do diagnóstico pós-processamento.");
    console.log(`📂 Arquivo JSON salvo em: ${outputPath}`);

    try {
      const diagnosticResult = writePostGenerationDiagnostics(data, outputPath);
      const { ERROR, WARN, INFO } = diagnosticResult.counts;
      console.log(`🧾 Diagnóstico pós-geração: ${ERROR} erro(s), ${WARN} aviso(s), ${INFO} informação(ões).`);
      console.log(`📋 Log salvo em: ${diagnosticResult.logPath}`);
      if (ERROR > 0 || WARN > 0) {
        console.log('⚠️ O JSON foi preservado. Consulte o log para tratamento posterior.');
      }
    } catch (diagnosticError) {
      console.error(`⚠️ Não foi possível gerar o log de diagnóstico: ${diagnosticError.message}`);
      console.error('   O arquivo JSON já foi salvo e permanece disponível.');
    }

    console.log("✅ Processamento concluído.");

    return [outputPath];
}

function reportPipelineError(error, context = '') {
    const prefix = context ? `${context}: ` : '';

    if (error?.name === 'VertexAIConfigurationError') {
      console.error(`❌ ${prefix}Configuração do Vertex AI inválida: ${error.message}`);
      console.error('   Configure GOOGLE_CLOUD_PROJECT e autentique por ADC ou GOOGLE_APPLICATION_CREDENTIALS.');
      return;
    }
    if (error?.name === 'AbortError' || /abort|timeout|timed out/i.test(error?.message || '')) {
      console.error(`❌ ${prefix}A chamada ao Gemini excedeu o tempo limite configurado.`);
      console.error("   Ajuste LEIAUT_TIMEOUT_MS se o arquivo for pequeno e a rede estiver lenta.");
      console.error("   Para arquivos grandes, divida o Markdown antes de rodar o LEIAUT.");
      return;
    }
    if (error?.code === 'LEIAUT_VERTEX_RETRIES_EXHAUSTED') {
      console.error(`❌ ${prefix}${error.message}`);
      console.error('   A saída desta execução não foi gravada. Aguarde a capacidade compartilhada normalizar ou avalie o endpoint global.');
      return;
    }

    console.error(`❌ ${prefix}Ocorreu um erro no pipeline LEIAUT:`, error);
}

async function processMarkdownDirectory(inputPath, inputFiles, args) {
  const outputBaseDir = path.join(process.cwd(), `${path.basename(inputPath)}_processado`);
  if (!args.dryRun && !fs.existsSync(outputBaseDir)) {
    fs.mkdirSync(outputBaseDir, { recursive: true });
  }

  console.log(`📁 Diretório de entrada: ${inputPath}`);
  console.log(`📄 Arquivos Markdown encontrados: ${inputFiles.length}`);
  console.log(`📂 Saída do lote: ${outputBaseDir}`);
  console.log('ℹ️  Somente arquivos .md diretamente neste diretório serão processados, em ordem numérica.');

  const failures = [];
  let successCount = 0;

  for (let index = 0; index < inputFiles.length; index++) {
    const inputFile = inputFiles[index];
    const fileName = path.basename(inputFile);
    const attemptStartedAt = Date.now();
    console.log(`\n${'='.repeat(72)}`);
    console.log(`📄 Arquivo ${index + 1}/${inputFiles.length}: ${fileName}`);

    try {
      await processMarkdownFile(inputFile, args, outputBaseDir);
      successCount++;
    } catch (error) {
      const previousOutputPath = path.join(
        outputBaseDir,
        `${path.parse(inputFile).name}_processado.json`
      );
      const staleOutputPath = fs.existsSync(previousOutputPath)
        && fs.statSync(previousOutputPath).mtimeMs < attemptStartedAt
        ? previousOutputPath
        : null;
      failures.push({
        fileName,
        message: error?.message || String(error),
        staleOutputPath
      });
      reportPipelineError(error, `Falha ao processar ${fileName}`);
    }
  }

  console.log(`\n${'='.repeat(72)}`);
  console.log('📊 RESUMO DO PROCESSAMENTO EM LOTE:');
  console.log(`✅ Arquivos processados com sucesso: ${successCount}`);
  console.log(`❌ Arquivos com erro: ${failures.length}`);
  console.log(`📁 Arquivos de saída: ${outputBaseDir}`);

  if (failures.length > 0) {
    console.log('\n❌ ERROS ENCONTRADOS:');
    failures.forEach((failure, index) => {
      console.log(`  ${index + 1}. ${failure.fileName}: ${failure.message}`);
      if (failure.staleOutputPath) {
        console.log(`     ⚠️ Saída antiga preservada (não pertence a esta execução): ${failure.staleOutputPath}`);
      }
    });
    process.exitCode = 1;
  }
}

async function processarResumo() {
  try {
    const args = parseLeiautArgs(process.argv.slice(2));
    const inputFile = args.inputFile;
    const inputPath = path.isAbsolute(inputFile) ? inputFile : path.join(process.cwd(), inputFile);

    if (!fs.existsSync(inputPath)) {
      const error = new Error(`Caminho de entrada não encontrado: ${inputPath}`);
      error.code = 'LEIAUT_INPUT_NOT_FOUND';
      throw error;
    }

    const resolvedInput = resolveMarkdownInputPaths(inputPath);
    if (resolvedInput.inputType === 'directory') {
      await processMarkdownDirectory(inputPath, resolvedInput.files, args);
      return;
    }

    await processMarkdownFile(resolvedInput.files[0], args);
  } catch (error) {
    reportPipelineError(error);
    process.exitCode = 1;
  }
}

if (require.main === module) {
    processarResumo();
}

module.exports = {
    processarResumo,
    processMarkdownFile,
    validateAndNormalizeOutput,
    cleanMermaidCode,
    parseLeiautArgs,
    resolveMarkdownInputPaths,
    countMarkdownHeadings,
    slugify,
    inferDiscipline,
    inferDisciplineFromFileName,
    extractOriginalDocumentTitle,
    getCanonicalTopicTitle,
    buildDeterministicOutputs,
    writeJsonOutput,
    splitByHeadingLevel,
    buildLeiautBlockPrompt,
    mergeLeiautBlockData,
    loadVisualManifest,
    buildVisualPromptInstruction,
    validateVisualManifestOutput,
    writeVisualValidationReport,
    collectPostGenerationDiagnostics,
    formatDiagnosticsLog,
    writePostGenerationDiagnostics,
    systemInstruction,
    normalizeStudyTitle,
    normalizeInlineTopicMarkers,
    removePygemRecoveryMarkers,
    removeOrphanMarkdownHeadings,
    validateMarkdownInput,
    assertSectionStructureMatchesSource,
    canonicalizeSectionTitlesFromSource,
    recoverEmptySectionsFromSource,
    assertImportableSections,
    getLevelTwoHeadingTitles,
    normalizeMarkdownTransportNewlines,
    normalizeMermaidTransportNewlines,
    normalizeContentTransportArtifacts,
    getVertexErrorStatus,
    isRetryableVertexError,
    shouldRetryVertexFailure,
    getRetryAfterMs,
    calculateRetryDelayMs,
    getVertexFinishReason,
    getVertexTokenUsage,
    calculateFlexibleOutputTokens
};
