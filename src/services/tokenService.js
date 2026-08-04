const logger = require('../utils/logger');

/**
 * Estima o número de tokens em um texto
 * Aproximação: 1 token ≈ 4 caracteres para português
 * @param {string} text - Texto para contar tokens
 * @returns {number} Número estimado de tokens
 */
function estimateTokens(text) {
    // Aproximação conservadora: 1 token = 3.5 caracteres
    return Math.ceil(text.length / 3.5);
}

function getTopLevelHeadingIndex(lines) {
    return lines.findIndex(line => /^##(?!#)\s+\S/.test(line.trim()));
}

function getSafeSubsectionSegments(lines) {
    const headings = [];
    lines.forEach((line, index) => {
        const match = line.trim().match(/^(#{3,6})\s+\S/);
        if (match) headings.push({ index, level: match[1].length });
    });

    if (headings.length === 0) return null;

    // Usa o nível mais alto disponível (normalmente ###), mantendo seus
    // subtítulos ####/##### juntos no mesmo fragmento.
    const splitLevel = Math.min(...headings.map(heading => heading.level));
    const headingIndexes = headings
        .filter(heading => heading.level === splitLevel)
        .map(heading => heading.index);

    const segments = [];
    const firstHeading = headingIndexes[0];
    const preface = lines.slice(0, firstHeading);
    if (preface.some(line => line.trim())) segments.push(preface);

    headingIndexes.forEach((start, index) => {
        const end = index + 1 < headingIndexes.length ? headingIndexes[index + 1] : lines.length;
        segments.push(lines.slice(start, end));
    });

    return segments.filter(segment => segment.some(line => line.trim()));
}

function getParagraphSegments(lines) {
    const segments = [];
    let current = [];

    lines.forEach(line => {
        if (!line.trim() && current.some(item => item.trim())) {
            segments.push(current);
            current = [];
            return;
        }
        current.push(line);
    });

    if (current.some(line => line.trim())) segments.push(current);
    return segments.length > 1 ? segments : null;
}

function splitOversizedUnit(unit, maxTokens) {
    const lines = unit.split(/\r?\n/);
    const headingIndex = getTopLevelHeadingIndex(lines);
    if (headingIndex < 0) return null;

    const prefix = lines.slice(0, headingIndex);
    const topHeading = lines[headingIndex].trim();
    const body = lines.slice(headingIndex + 1);
    const renderSegments = candidateSegments => {
        if (!candidateSegments) return null;
        const fragments = [];
        let current = [];
        candidateSegments.forEach(segment => {
            const candidate = [...current, ...segment];
            const candidateText = [topHeading, ...candidate].join('\n').trim();
            if (current.length > 0 && estimateTokens(candidateText) > maxTokens) {
                fragments.push(current);
                current = segment;
                return;
            }
            current = candidate;
        });
        if (current.length > 0) fragments.push(current);
        return fragments.map((fragment, index) => {
            const fragmentPrefix = index === 0 ? prefix : [];
            return [...fragmentPrefix, topHeading, ...fragment].join('\n').trim();
        });
    };

    const subsectionSegments = getSafeSubsectionSegments(body);
    let rendered = renderSegments(subsectionSegments);
    if (!rendered || rendered.some(fragment => estimateTokens(fragment) > maxTokens)) {
        rendered = renderSegments(getParagraphSegments(body));
    }
    if (!rendered || rendered.some(fragment => estimateTokens(fragment) > maxTokens)) return null;
    return rendered.length > 1 ? rendered : null;
}

/**
 * Divide o conteúdo em blocos de tamanho aproximado em tokens
 * @param {string} content - Conteúdo a ser dividido
 * @param {number} maxTokens - Máximo de tokens por bloco (padrão: 5000)
 * @returns {string[]} - Array de blocos de conteúdo
 */
function splitContentIntoBlocks(content, maxTokens = 2800) {
    const blocks = [];
    const lines = String(content || '').split(/\r?\n/);
    const structuralUnits = [];
    let currentUnit = [];

    logger.info(`Dividindo conteúdo em blocos de até ${maxTokens} tokens`);

    lines.forEach(line => {
        const startsTopLevelSection = /^##(?!#)\s+\S/.test(line.trim());
        if (startsTopLevelSection && currentUnit.some(item => item.trim())) {
            structuralUnits.push(currentUnit.join('\n').trim());
            currentUnit = [];
        }
        currentUnit.push(line);
    });

    if (currentUnit.some(line => line.trim())) {
        structuralUnits.push(currentUnit.join('\n').trim());
    }

    let currentBlock = '';
    structuralUnits.forEach((unit, index) => {
        const unitTokens = estimateTokens(unit);
        if (unitTokens > maxTokens) {
            const splitUnit = splitOversizedUnit(unit, maxTokens);
            if (splitUnit) {
                logger.warn?.(
                    `${unit.split(/\r?\n/).find(line => /^##(?!#)\s+\S/.test(line.trim()))?.trim() || 'Seção'} `
                    + `foi dividida em ${splitUnit.length} fragmentos por limites estruturais.`
                );
                splitUnit.forEach(fragment => {
                    const candidate = currentBlock ? `${currentBlock}\n\n${fragment}` : fragment;
                    if (currentBlock && estimateTokens(candidate) > maxTokens) {
                        blocks.push(currentBlock);
                        currentBlock = fragment;
                    } else {
                        currentBlock = candidate;
                    }
                });
                return;
            }

            const heading = unit.split(/\r?\n/).find(line => /^##(?!#)\s+\S/.test(line.trim()));
            const label = heading ? heading.trim() : `unidade estrutural ${index + 1}`;
            const error = new Error(
                `${label} possui ~${unitTokens} tokens e excede o limite de ${maxTokens}. `
                + 'Não foi encontrado limite seguro em subtítulos ou parágrafos; corrija a fonte ou aumente o limite conscientemente.'
            );
            error.code = 'LEIAUT_SECTION_TOO_LARGE';
            throw error;
        }

        const candidate = currentBlock ? `${currentBlock}\n\n${unit}` : unit;
        if (currentBlock && estimateTokens(candidate) > maxTokens) {
            blocks.push(currentBlock);
            currentBlock = unit;
        } else {
            currentBlock = candidate;
        }
    });

    if (currentBlock) blocks.push(currentBlock);
    
    logger.info(`Conteúdo dividido em ${blocks.length} blocos`);
    
    // Log dos tamanhos dos blocos
    blocks.forEach((block, index) => {
        const tokens = estimateTokens(block);
        logger.info(`Bloco ${index + 1}: ~${tokens} tokens`);
    });
    
    return blocks;
}

/**
 * Aguarda um determinado número de segundos
 * @param {number} seconds - Número de segundos para aguardar
 */
function sleep(seconds) {
    return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

module.exports = {
    estimateTokens,
    splitContentIntoBlocks,
    sleep
};
