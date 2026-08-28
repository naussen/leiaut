const FLASHCARD_PREFIX = '[CERTO/ERRADO]';
const ALLOWED_BOARDS = new Set(['CESPE', 'CEBRASPE', 'FCC', 'FGV']);

class FlashcardQualityError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'FlashcardQualityError';
    this.details = details;
  }
}

function classifyFlashcard(question) {
  return String(question || '').trim().startsWith(FLASHCARD_PREFIX) ? 'trueFalse' : null;
}

function canonicalLegalText(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ').trim().toLowerCase();
}

function hasExplicitLegalText(sourceMarkdown) {
  return /(?:^|\n)\s*(?:>\s*)?(?:\*{0,2})Art(?:igo)?\.?\s*\d+/im.test(String(sourceMarkdown || ''));
}

function extractSourceQuestionBlocks(sourceMarkdown) {
  return String(sourceMarkdown || '').split(/\n\s*\n/).map(block => block.trim())
    .filter(block => /\b(?:quest[aã]o|CEBRASPE|CESPE|FGV|FCC|concurso|gabarito)\b/iu.test(block));
}

function hasSubstantialQuestionCopy(question, sourceMarkdown, minimumRun = 7) {
  const normalize = value => canonicalLegalText(value).split(/\s+/).filter(token => token.length >= 3);
  const questionTokens = normalize(String(question || '').replace(/^\[CERTO\/ERRADO\]\s*/iu, ''));
  if (questionTokens.length < minimumRun) return false;
  return extractSourceQuestionBlocks(sourceMarkdown).some(block => {
    const source = ` ${normalize(block).join(' ')} `;
    return questionTokens.some((_, index) => index <= questionTokens.length - minimumRun
      && source.includes(` ${questionTokens.slice(index, index + minimumRun).join(' ')} `));
  });
}

function validateFlashcard(section, flashcard, index) {
  const prefix = `${section.section_id}.flashcards[${index}]`;
  const issues = [];
  const question = String(flashcard.question || '').trim();
  const answer = String(flashcard.answer || '').trim();
  if (!classifyFlashcard(question)) return [`${prefix}.question: use o prefixo [CERTO/ERRADO].`];
  if (!/^Gabarito:\s*(?:CERTO|ERRADO)\.\s*Justificativa:\s*\S/iu.test(answer)) {
    issues.push(`${prefix}.answer: CERTO/ERRADO exige "Gabarito: CERTO|ERRADO. Justificativa: ...".`);
  }
  const source = flashcard.source;
  if (!source || typeof source !== 'object') return [...issues, `${prefix}.source: origem da questão é obrigatória.`];
  if (!ALLOWED_BOARDS.has(source.board)) issues.push(`${prefix}.source.board: use CESPE, CEBRASPE, FCC ou FGV.`);
  if (!Number.isInteger(source.year) || source.year < 2000 || source.year > new Date().getFullYear()) issues.push(`${prefix}.source.year: ano inválido.`);
  if (!String(source.exam || '').trim()) issues.push(`${prefix}.source.exam: concurso/cargo obrigatório.`);
  if (!String(source.question_id || '').trim()) issues.push(`${prefix}.source.question_id: identificador obrigatório.`);
  if (source.status !== 'valid') issues.push(`${prefix}.source.status: somente questão válida e não anulada é aceita.`);
  const sourceText = String(section.content_markdown || '');
  for (const value of [source.board, source.year, source.exam, source.question_id]) {
    if (!sourceText.includes(String(value))) issues.push(`${prefix}.source: referência não foi encontrada no material de origem.`);
  }
  return issues;
}

function validateSectionFlashcards(section, flashcards) {
  return flashcards.flatMap((flashcard, index) => validateFlashcard(section, flashcard, index));
}

function validateTopicFlashcards(data) {
  const issues = (data.sections || []).flatMap(section => validateSectionFlashcards(section, section.flashcards || []));
  if (issues.length) throw new FlashcardQualityError('Flashcards reprovados na validação de origem e formato.', issues);
  return data;
}

module.exports = { FLASHCARD_PREFIX, FlashcardQualityError, canonicalLegalText, classifyFlashcard,
  extractSourceQuestionBlocks, hasExplicitLegalText, hasSubstantialQuestionCopy, validateFlashcard,
  validateSectionFlashcards, validateTopicFlashcards };
