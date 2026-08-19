const path = require('path');

const NON_FRAGMENTING_SHORT_SEGMENTS = new Set(['a', 'ao', 'as', 'da', 'das', 'de', 'do', 'dos', 'e', 'o', 'os']);

function normalizeSlug(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function inspectTopicSlug(value, { title = '' } = {}) {
    const slug = String(value || '').trim();
    const reasons = [];
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) reasons.push('formato-nao-canonico');
    if (/--|^-|-$/.test(slug)) reasons.push('separadores-repetidos');
    const segments = slug ? slug.split('-') : [];
    const shortSegments = segments.filter(segment => (
        segment.length <= 2 && !NON_FRAGMENTING_SHORT_SEGMENTS.has(segment)
    )).length;
    if (shortSegments >= 3 || (segments.length >= 5 && shortSegments / segments.length >= 0.6)) {
        reasons.push('fragmentacao-excessiva');
    }
    const normalizedTitle = normalizeSlug(title);
    if (normalizedTitle && slug.length > Math.max(80, normalizedTitle.length * 2.5)) {
        reasons.push('comprimento-desproporcional');
    }
    return { slug, reasons, suspicious: reasons.length > 0 };
}

function assertCanonicalTopicSlug(value, context = {}) {
    const inspection = inspectTopicSlug(value, context);
    if (!inspection.slug || inspection.suspicious) {
        const error = new Error(
            `topic_slug suspeito; informe o valor canônico no manifesto visual${inspection.reasons.length ? ` (${inspection.reasons.join(', ')})` : ''}.`
        );
        error.code = 'LEIAUT_TOPIC_SLUG_SUSPECT';
        error.details = inspection;
        throw error;
    }
    return inspection.slug;
}

function selectManifestTopic(topics = [], topicTitle = '') {
    if (!Array.isArray(topics) || topics.length === 0) return null;
    if (topics.length === 1) return topics[0];
    const target = normalizeSlug(topicTitle);
    const exact = topics.find(topic => normalizeSlug(topic.topic_title) === target);
    if (exact) return exact;
    const error = new Error(`Manifesto visual ambíguo para o tópico "${topicTitle}".`);
    error.code = 'LEIAUT_TOPIC_SLUG_AMBIGUOUS';
    error.details = { topicTitle, topics: topics.map(topic => topic.topic_slug) };
    throw error;
}

function resolveTopicId({ topics, topicTitle, fallbackTopicId }) {
    const topic = selectManifestTopic(topics, topicTitle);
    if (topic?.topic_slug) return assertCanonicalTopicSlug(topic.topic_slug, { title: topic.topic_title });
    return normalizeSlug(fallbackTopicId || topicTitle) || 'topico-indefinido';
}

function assertUniqueTopicIds(records = []) {
    const seen = new Map();
    records.forEach(record => {
        const topicId = record?.data?.topic_id || record?.topic_id;
        if (!topicId) return;
        if (seen.has(topicId)) {
            const error = new Error(`topic_id duplicado no lote: ${topicId}.`);
            error.code = 'LEIAUT_TOPIC_ID_DUPLICATE';
            error.details = { topicId, sources: [seen.get(topicId), record.source_file || record.fileSuffix || null] };
            throw error;
        }
        seen.set(topicId, record.source_file || record.fileSuffix || null);
    });
    return records;
}

function buildTopicIdMigrationMap(oldData, newData, sourceFile = '') {
    const oldTopicId = oldData?.topic_id || null;
    const newTopicId = newData?.topic_id || null;
    if (!oldTopicId || !newTopicId || oldTopicId === newTopicId) return null;
    return {
        source_file: sourceFile ? path.basename(sourceFile) : null,
        topic_title: newData?.topic_title || oldData?.topic_title || null,
        old_topic_id: oldTopicId,
        new_topic_id: newTopicId,
        reason: 'autoridade-canonica-do-manifesto-visual'
    };
}

module.exports = {
    normalizeSlug,
    inspectTopicSlug,
    assertCanonicalTopicSlug,
    selectManifestTopic,
    resolveTopicId,
    assertUniqueTopicIds,
    buildTopicIdMigrationMap,
};
