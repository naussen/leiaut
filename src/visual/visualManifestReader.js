const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeKey(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase('pt-BR')
        .replace(/[^a-z0-9]+/g, '');
}

function readJsonFile(filePath) {
    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        const error = new Error(`Manifesto visual não encontrado: ${resolvedPath}`);
        error.code = 'LEIAUT_VISUAL_MANIFEST_NOT_FOUND';
        throw error;
    }
    if (fs.statSync(resolvedPath).size > MAX_MANIFEST_BYTES) {
        const error = new Error(`Manifesto visual excede o limite de ${MAX_MANIFEST_BYTES} bytes.`);
        error.code = 'LEIAUT_VISUAL_MANIFEST_TOO_LARGE';
        throw error;
    }
    let value;
    try {
        value = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
    } catch (parseError) {
        const error = new Error(`Manifesto visual inválido: ${parseError.message}`);
        error.code = 'LEIAUT_VISUAL_MANIFEST_JSON_INVALID';
        throw error;
    }
    return { resolvedPath, value };
}

function validateManifestShape(manifest) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        throw new Error('Manifesto visual deve ser um objeto JSON.');
    }
    if (manifest.schema_version !== 1) {
        throw new Error('Manifesto visual deve usar schema_version 1.');
    }
    if (!Array.isArray(manifest.topics) || manifest.topics.length === 0) {
        throw new Error('Manifesto visual deve conter topics não vazio.');
    }
    manifest.topics.forEach((topic, index) => {
        if (!topic || typeof topic !== 'object' || !String(topic.topic_slug || '').trim()) {
            throw new Error(`Manifesto visual: tópico ${index + 1} inválido.`);
        }
        if (!Array.isArray(topic.requirements)) {
            throw new Error(`Manifesto visual: requirements ausente no tópico ${topic.topic_slug}.`);
        }
        topic.requirements.forEach((requirement, requirementIndex) => {
            if (!['table', 'mermaid', 'highlight', 'mnemonic'].includes(requirement?.resource)) {
                throw new Error(`Manifesto visual: resource inválido em ${topic.topic_slug}, requisito ${requirementIndex + 1}.`);
            }
            if (!Number.isInteger(requirement.minimum) || !Number.isInteger(requirement.maximum)
                || requirement.minimum < 0 || requirement.maximum < requirement.minimum) {
                throw new Error(`Manifesto visual: cardinalidade inválida em ${topic.topic_slug}.`);
            }
        });
    });
    ['guide_sha256', 'source_sha256', 'output_sha256'].forEach(field => {
        if (manifest[field] !== undefined && !SHA256_PATTERN.test(manifest[field])) {
            throw new Error(`Manifesto visual: ${field} não possui SHA-256 válido.`);
        }
    });
    return manifest;
}

function discoverVisualManifestPath(inputPath, explicitPath = null) {
    if (explicitPath) return path.resolve(explicitPath);
    const stats = fs.statSync(inputPath);
    const directory = stats.isDirectory() ? inputPath : path.dirname(inputPath);
    const stem = stats.isDirectory() ? path.basename(inputPath) : path.parse(inputPath).name;
    const candidates = [
        path.join(directory, '_visual-manifest.json'),
        path.join(directory, '_visual-plan.json'),
        path.join(directory, `${stem}.visual-manifest.json`),
        path.join(directory, `${stem}.visual-plan.json`),
    ];
    return candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
}

function matchesTopic(topic, inputPath, markdown) {
    const fileIndex = path.basename(inputPath).match(/^(\d{3})(?:_|-)/)?.[1] || null;
    if (topic.source_index && topic.source_index === fileIndex) return true;
    const expected = normalizeKey(topic.canonical_title || topic.topic_slug);
    if (!expected) return false;
    return String(markdown || '').split(/\r?\n/).some(line => {
        const heading = line.trim().match(/^@@@?\s+(.+)$|^#{1,6}\s+(.+)$/);
        if (!heading) return false;
        const actual = normalizeKey(heading[1] || heading[2]);
        return actual === expected || actual.includes(expected) || expected.includes(actual);
    });
}

function selectVisualTopics(manifest, inputPath, markdown) {
    const matches = manifest.topics.filter(topic => matchesTopic(topic, inputPath, markdown));
    if (matches.length > 0) return matches;
    if (manifest.topics.length === 1) return manifest.topics;
    return [];
}

function loadVisualManifest({ inputPath, explicitPath = null, markdown = '' } = {}) {
    const manifestPath = discoverVisualManifestPath(inputPath, explicitPath);
    if (!manifestPath) return null;
    const loaded = readJsonFile(manifestPath);
    const manifest = validateManifestShape(loaded.value);
    if (manifest.source_sha256 && fs.statSync(inputPath).isFile()) {
        const sourceHash = sha256(fs.readFileSync(inputPath));
        if (sourceHash !== manifest.source_sha256) {
            const error = new Error(
                `Hash do recursos visuais não corresponde ao Markdown de ${path.basename(inputPath)}.`
            );
            error.code = 'LEIAUT_VISUAL_MANIFEST_HASH_MISMATCH';
            error.details = { expected: manifest.source_sha256, observed: sourceHash };
            throw error;
        }
    }
    const topics = selectVisualTopics(manifest, inputPath, markdown);
    if (topics.length === 0) {
        const error = new Error(`Nenhum tópico do manifesto visual corresponde a ${path.basename(inputPath)}.`);
        error.code = 'LEIAUT_VISUAL_TOPIC_NOT_MATCHED';
        throw error;
    }
    return {
        manifest,
        manifestPath: loaded.resolvedPath,
        manifestHash: sha256(fs.readFileSync(loaded.resolvedPath)),
        topics,
        inputType: manifest.source_sha256 ? 'visual-manifest' : 'visual-plan',
    };
}

function buildVisualPromptInstruction(context) {
    if (!context || !Array.isArray(context.topics) || context.topics.length === 0) return '';
    const lines = context.topics.flatMap(topic => [
        `- tópico=${topic.topic_slug}`,
        ...topic.requirements.map(requirement => (
            `  recurso=${requirement.resource}; papel=${requirement.semantic_role}; `
            + `quantidade=${requirement.minimum}..${requirement.maximum}; `
            + `variante=${requirement.variant_family || 'preservar'}; obrigatório=${requirement.required ? 'sim' : 'não'}`
        )),
    ]);
    return [
        'CONTRATO VISUAL VINCULADO AO PYGEM:',
        'As quantidades do contrato são globais para o arquivo inteiro, não uma cota por seção. Quando o máximo for 1, produza exatamente uma ocorrência no JSON e não repita o recurso em outras seções.',
        'Para highlight, conte cada item de callouts como uma ocorrência global; quando houver máximo 1, retorne somente um callout no arquivo inteiro.',
        'Para mermaid, preencha mermaid_mindmap em uma única seção quando o máximo for 1; nunca espalhe o mesmo diagrama por várias seções.',
        'Preserve no JSON o mesmo tipo de recurso visual já produzido no Markdown.',
        'Não substitua tabela por Mermaid, Mermaid por lista, realce por texto comum ou mnemônico por outro recurso.',
        'Não invente recursos ausentes e não altere o conteúdo factual para cumprir o contrato.',
        'Mermaid obrigatÃ³rio: use um Ãºnico graph TD ou flowchart TD curto, com 2 a 6 nÃ³s e no mÃ¡ximo 6 relaÃ§Ãµes; se a fonte for densa, comprima para a pergunta decisÃ³ria e os principais desfechos.',
        ...lines,
    ].join('\n');
}

module.exports = {
    MAX_MANIFEST_BYTES,
    sha256,
    normalizeKey,
    validateManifestShape,
    discoverVisualManifestPath,
    selectVisualTopics,
    loadVisualManifest,
    buildVisualPromptInstruction,
};
