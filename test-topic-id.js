const assert = require('assert');
const {
    inspectTopicSlug,
    assertCanonicalTopicSlug,
    resolveTopicId,
    assertUniqueTopicIds,
    buildTopicIdMigrationMap,
} = require('./src/visual/topicIdAuthority');
const { selectVisualTopics } = require('./src/visual/visualManifestReader');

assert.strictEqual(resolveTopicId({
    topics: [{ topic_slug: 'direito-administrativo', topic_title: 'Direito Administrativo' }],
    topicTitle: 'Direito Administrativo',
    fallbackTopicId: 'outro',
}), 'direito-administrativo');
assert.strictEqual(
    assertCanonicalTopicSlug('relatorio-de-auditoria-nbc-ta-700-701-705-e-706'),
    'relatorio-de-auditoria-nbc-ta-700-701-705-e-706'
);
assert.strictEqual(
    assertCanonicalTopicSlug('lei-6-404-76-acoes-em-tesouraria'),
    'lei-6-404-76-acoes-em-tesouraria'
);
assert.strictEqual(
    assertCanonicalTopicSlug('cpc-18-investimento-em-coligada-controlada-e-empreendimento-controlado-em-conjunto-ecc'),
    'cpc-18-investimento-em-coligada-controlada-e-empreendimento-controlado-em-conjunto-ecc'
);
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
assert.deepStrictEqual(
    selectVisualTopics({
        topics: [
            { source_index: '009', canonical_title: 'Comunicação dos Atos Processuais', topic_slug: 'comunicacao-dos-atos-processuais' },
            { source_index: '015', canonical_title: 'Lei 9.099/95 – Juizados Especiais Criminais', topic_slug: 'lei-9-099-95-juizados-especiais-criminais' },
        ],
    }, '015_Lei_9_099_95_Juizados_Especiais_Criminais_reescrito.md', '# Lei 9.099/95 – Juizados Especiais Criminais\n\n### Atos Processuais'),
    [{ source_index: '015', canonical_title: 'Lei 9.099/95 – Juizados Especiais Criminais', topic_slug: 'lei-9-099-95-juizados-especiais-criminais' }]
);

console.log('test-topic-id: ok');
