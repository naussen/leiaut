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

/**
 * Divide o conteúdo em blocos de tamanho aproximado em tokens
 * @param {string} content - Conteúdo a ser dividido
 * @param {number} maxTokens - Máximo de tokens por bloco (padrão: 5000)
 * @param {object} options - Limites adicionais para unidades estruturais indivisíveis
 * @returns {string[]} - Array de blocos de conteúdo
 */
function splitContentIntoBlocks(content, maxTokens = 2800, options = {}) {
    const blocks = [];
    const lines = String(content || '').split(/\r?\n/);
    const structuralUnits = [];
    const configuredStructuralLimit = Number(options.maxStructuralUnitTokens);
    const maxStructuralUnitTokens = Number.isFinite(configuredStructuralLimit)
        ? Math.max(maxTokens, Math.floor(configuredStructuralLimit))
        : maxTokens;
    let currentUnit = [];
    let hasTopLevelSection = false;

    logger.info(`Dividindo conteúdo em blocos de até ${maxTokens} tokens`);

    lines.forEach(line => {
        const startsTopLevelSection = /^##(?!#)\s+\S/.test(line.trim());
        if (startsTopLevelSection && hasTopLevelSection && currentUnit.some(item => item.trim())) {
            structuralUnits.push(currentUnit.join('\n').trim());
            currentUnit = [];
        }
        if (startsTopLevelSection) hasTopLevelSection = true;
        currentUnit.push(line);
    });

    if (currentUnit.some(line => line.trim())) {
        structuralUnits.push(currentUnit.join('\n').trim());
    }

    let currentBlock = '';
    structuralUnits.forEach((unit, index) => {
        const unitTokens = estimateTokens(unit);
        if (unitTokens > maxTokens) {
            const heading = unit.split(/\r?\n/).find(line => /^##(?!#)\s+\S/.test(line.trim()));
            const label = heading ? heading.trim() : `unidade estrutural ${index + 1}`;
            if (unitTokens > maxStructuralUnitTokens) {
                const error = new Error(
                    `${label} possui ~${unitTokens} tokens e excede o teto seguro de ${maxStructuralUnitTokens}. `
                    + 'O LEIAUT não divide uma seção principal no meio; divida a seção na fonte ou aumente '
                    + 'LEIAUT_MAX_SECTION_TOKENS conscientemente.'
                );
                error.code = 'LEIAUT_SECTION_TOO_LARGE';
                throw error;
            }

            if (currentBlock) {
                blocks.push(currentBlock);
                currentBlock = '';
            }
            blocks.push(unit);
            logger.warn(
                `${label} possui ~${unitTokens} tokens e será mantida como bloco isolado `
                + `(alvo normal: ${maxTokens}; teto seguro: ${maxStructuralUnitTokens}).`
            );
            return;
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
