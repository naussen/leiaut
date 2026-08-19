const assert = require('assert');
const {
    inspectTopicSlug,
    assertCanonicalTopicSlug,
    resolveTopicId,
    assertUniqueTopicIds,
    buildTopicIdMigrationMap,
} = require('./src/visual/topicIdAuthority');

assert.strictEqual(resolveTopicId({
    topics: [{ topic_slug: 'direito-administrativo', topic_title: 'Direito Administrativo' }],
    topicTitle: 'Direito Administrativo',
    fallbackTopicId: 'outro',
}), 'direito-administrativo');
assert.strictEqual(inspectTopicSlug('a-b-c-d', { title: 'Tema' }).suspicious, true);
assert.throws(() => assertCanonicalTopicSlug('tema--fragmentado'), error => error.code === 'LEIAUT_TOPIC_SLUG_SUSPECT');
assert.throws(() => assertUniqueTopicIds([
    { fileSuffix: '001', data: { topic_id: 'duplicado' } },
    { fileSuffix: '002', data: { topic_id: 'duplicado' } },
]), error => error.code === 'LEIAUT_TOPIC_ID_DUPLICATE');
assert.deepStrictEqual(buildTopicIdMigrationMap(
    { topic_id: 'modelo-antigo', topic_title: 'Tema' },
    { topic_id: 'tema-canonico', topic_title: 'Tema' },
    'tema.md'
), {
    source_file: 'tema.md',
    topic_title: 'Tema',
    old_topic_id: 'modelo-antigo',
    new_topic_id: 'tema-canonico',
    reason: 'autoridade-canonica-do-manifesto-visual'
});

console.log('test-topic-id: ok');
