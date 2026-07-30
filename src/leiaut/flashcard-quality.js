const FLASHCARD_PREFIXES = Object.freeze({
  trueFalse: '[CERTO/ERRADO]',
  law: '[LETRA DA LEI]',
});

const PROHIBITED_ATTRIBUTION_PATTERN = /\b(?:CEBRASPE|CESPE|FGV|FCC|banca|adaptad[ao]|quest[aã]o\s+real)\b/iu;

class FlashcardQualityError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'FlashcardQualityError';
    this.details = details;
  }
}

function classifyFlashcard(question) {
  const value = String(question || '').trim();
  return Object.entries(FLASHCARD_PREFIXES).find(([, prefix]) => value.startsWith(prefix))?.[0] || null;
}

function canonicalLegalText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[*_`#>"“”'‘’()[\]{}]/g, ' ')
    .replace(/[^a-zA-Z0-9§ºª]+/g, ' ')
    .trim()
    .toLowerCase();
}

function hasExplicitLegalText(sourceMarkdown) {
  return /(?:^|\n)\s*(?:>\s*)?(?:\*{0,2})Art(?:igo)?\.?\s*\d+/im.test(String(sourceMarkdown || ''));
}

function normalizeQuestionTokens(value) {
  return canonicalLegalText(value).split(/\s+/).filter(token => token.length >= 3);
}

function extractSourceQuestionBlocks(sourceMarkdown) {
  return String(sourceMarkdown || '')
    .split(/\n\s*\n/)
    .map(block => block.trim())
    .filter(block => (
      /\b(?:quest[aã]o|CEBRASPE|CESPE|FGV|FCC|concurso|gabarito)\b/iu.test(block)
      || /\?\s*(?:$|\n)/u.test(block)
      || /(?:^|\n)\s*[A-E][).]\s+\S/u.test(block)
    ));
}

function hasSubstantialQuestionCopy(question, sourceMarkdown, minimumRun = 7) {
  const questionTokens = normalizeQuestionTokens(
    String(question || '').replace(/^\[(?:CERTO\/ERRADO|LETRA DA LEI)\]\s*/iu, '')
  );
  if (questionTokens.length < minimumRun) return false;

  return extractSourceQuestionBlocks(sourceMarkdown).some(block => {
    const blockTokens = normalizeQuestionTokens(block);
    const blockText = ` ${blockTokens.join(' ')} `;
    for (let index = 0; index <= questionTokens.length - minimumRun; index += 1) {
      const run = ` ${questionTokens.slice(index, index + minimumRun).join(' ')} `;
      if (blockText.includes(run)) return true;
    }
    return false;
  });
}

function validateFlashcard(section, flashcard, index) {
  const prefix = `${section.section_id}.flashcards[${index}]`;
  const issues = [];
  const question = String(flashcard.question || '').trim();
  const answer = String(flashcard.answer || '').trim();
  const type = classifyFlashcard(question);

  if (!type) {
    issues.push(`${prefix}.question: use o prefixo [CERTO/ERRADO] ou [LETRA DA LEI].`);
    return issues;
  }

  if (PROHIBITED_ATTRIBUTION_PATTERN.test(`${question} ${answer}`)) {
    issues.push(`${prefix}: nao mencione banca, concurso, adaptacao ou alegacao de questao real.`);
  }

  if (type === 'trueFalse') {
    if (!/^Gabarito:\s*(?:CERTO|ERRADO)\.\s*Justificativa:\s*\S/iu.test(answer)) {
      issues.push(`${prefix}.answer: CERTO/ERRADO exige "Gabarito: CERTO|ERRADO. Justificativa: ...".`);
    }
    if (hasSubstantialQuestionCopy(question, section.content_markdown)) {
      issues.push(`${prefix}.question: copia substancial de questao existente na fonte.`);
    }
  }

  if (type === 'law') {
    const articleMatch = question.match(/\bArt(?:igo)?\.?\s*(\d+[A-Za-z]?)/iu);
    if (!articleMatch) {
      issues.push(`${prefix}.question: LETRA DA LEI deve citar um artigo numerado.`);
    } else {
      const sourceArticlePattern = new RegExp(`\\bArt(?:igo)?\\.?\\s*${articleMatch[1]}(?:º|°|o)?\\b`, 'iu');
      if (!sourceArticlePattern.test(section.content_markdown)) {
        issues.push(`${prefix}.question: o artigo citado nao consta na fonte da secao.`);
      }
    }
    const legalText = answer.replace(/^Texto legal:\s*/iu, '').replace(/[.!?]\s*$/u, '').trim();
    if (!/^Texto legal:\s*\S/iu.test(answer)) {
      issues.push(`${prefix}.answer: LETRA DA LEI exige "Texto legal: ...".`);
    } else if (
      canonicalLegalText(legalText).length < 12
      || !canonicalLegalText(section.content_markdown).includes(canonicalLegalText(legalText))
    ) {
      issues.push(`${prefix}.answer: o texto legal deve ser reproducao literal de trecho presente na fonte.`);
    }
  }

  return issues;
}

function validateSectionFlashcards(section, flashcards, options = {}) {
  const issues = [];
  flashcards.forEach((flashcard, index) => issues.push(...validateFlashcard(section, flashcard, index)));
  if (options.requireLegalCard && hasExplicitLegalText(section.content_markdown)) {
    if (!flashcards.some(flashcard => classifyFlashcard(flashcard.question) === 'law')) {
      issues.push(`${section.section_id}.flashcards: conteudo juridico com letra legal expressa exige cartao LETRA DA LEI.`);
    }
    if (!flashcards.some(flashcard => classifyFlashcard(flashcard.question) === 'trueFalse')) {
      issues.push(`${section.section_id}.flashcards: conteudo juridico com letra legal expressa exige tambem cartao CERTO/ERRADO.`);
    }
  }
  return issues;
}

function validateTopicFlashcards(data) {
  const issues = [];
  const legalDiscipline = /^Direito\b/iu.test(String(data.discipline || '').trim());
  (data.sections || []).forEach(section => {
    issues.push(...validateSectionFlashcards(section, section.flashcards || [], {
      requireLegalCard: legalDiscipline,
    }));
  });
  if (issues.length > 0) {
    throw new FlashcardQualityError('Flashcards reprovados na validacao de formato.', issues);
  }
  return data;
}

module.exports = {
  FLASHCARD_PREFIXES,
  FlashcardQualityError,
  canonicalLegalText,
  classifyFlashcard,
  extractSourceQuestionBlocks,
  hasExplicitLegalText,
  hasSubstantialQuestionCopy,
  validateFlashcard,
  validateSectionFlashcards,
  validateTopicFlashcards,
};
