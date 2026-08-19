const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { processMarkdownFile } = require('./src/app-leiaut');

(async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'leiaut-publication-'));
    try {
        const inputPath = path.join(directory, '010_teste.md');
        const outputDirectory = path.join(directory, 'saida');
        const outputPath = path.join(outputDirectory, '010_teste_processado.json');
        const manifestPath = path.join(directory, '_visual-plan.json');
        fs.mkdirSync(outputDirectory, { recursive: true });
        fs.writeFileSync(inputPath, '## Teste visual\n\nConteúdo sem tabela.', 'utf8');
        fs.writeFileSync(manifestPath, JSON.stringify({
            schema_version: 1,
            guide_id: 'teste-visual-v1',
            guide_sha256: '0'.repeat(64),
            diversification_seed: 'teste-v1',
            topics: [{
                source_index: '010',
                canonical_title: 'Teste visual',
                topic_slug: 'teste-visual',
                requirements: [{
                    resource: 'table',
                    semantic_role: 'comparison',
                    required: true,
                    minimum: 1,
                    maximum: 1,
                }],
            }],
        }), 'utf8');
        const previous = { previous: true, topic_id: 'versao-anterior' };
        fs.writeFileSync(outputPath, JSON.stringify(previous), 'utf8');

        await assert.rejects(
            processMarkdownFile(inputPath, {
                noAi: true,
                splitByTopic: false,
                dryRun: false,
                visualManifest: null,
            }, outputDirectory),
            error => error.code === 'LEIAUT_VISUAL_COMPLIANCE_INVALID'
        );
        assert.deepStrictEqual(
            JSON.parse(fs.readFileSync(outputPath, 'utf8')),
            previous,
            'Divergência visual não pode substituir JSON anterior'
        );
        assert(fs.existsSync(path.join(outputDirectory, '010_teste_processado.visual-validation.json')));
        console.log('Teste de publicação atômica e bloqueio visual: OK');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
