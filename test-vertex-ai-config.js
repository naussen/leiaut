const assert = require('assert');
const {
  DEFAULT_VERTEX_API_VERSION,
  DEFAULT_VERTEX_LOCATION,
  DEFAULT_VERTEX_MODEL,
  VertexAIConfigurationError,
  createVertexAIClient,
  getVertexAIConfig,
  getVertexThinkingConfig,
} = require('./src/config/vertex-ai');

function test(name, callback) {
  try {
    callback();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    console.error(`  ❌ ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

console.log('\n🧪 ===== Testes de configuração Vertex AI =====\n');

test('exige GOOGLE_CLOUD_PROJECT', () => {
  assert.throws(
    () => getVertexAIConfig({}, { checkCredentialsFile: false }),
    error => error instanceof VertexAIConfigurationError
      && error.message.includes('GOOGLE_CLOUD_PROJECT')
  );
});

test('usa padrões seguros do Vertex AI', () => {
  const config = getVertexAIConfig(
    { GOOGLE_CLOUD_PROJECT: 'projeto-teste' },
    { checkCredentialsFile: false }
  );
  assert.strictEqual(config.project, 'projeto-teste');
  assert.strictEqual(config.location, DEFAULT_VERTEX_LOCATION);
  assert.strictEqual(config.model, DEFAULT_VERTEX_MODEL);
  assert.strictEqual(config.apiVersion, DEFAULT_VERTEX_API_VERSION);
  assert.strictEqual(config.credentialsSource, 'Application Default Credentials (ADC)');
});

test('aceita região e modelo configuráveis', () => {
  const config = getVertexAIConfig({
    GOOGLE_CLOUD_PROJECT: 'projeto-teste',
    GOOGLE_CLOUD_LOCATION: 'southamerica-east1',
    VERTEX_MODEL: 'modelo-fixture',
  }, { checkCredentialsFile: false });
  assert.strictEqual(config.location, 'southamerica-east1');
  assert.strictEqual(config.model, 'modelo-fixture');
});

test('adapta a configuração de pensamento à família do modelo', () => {
  assert.deepStrictEqual(
    getVertexThinkingConfig('gemini-3.5-flash', 100),
    { thinkingLevel: 'MINIMAL', includeThoughts: false }
  );
  assert.deepStrictEqual(
    getVertexThinkingConfig('gemini-2.5-flash', 100),
    { thinkingBudget: 100, includeThoughts: false }
  );
});

test('ignora API Keys e mantém o backend Vertex AI', () => {
  const config = getVertexAIConfig({
    GOOGLE_CLOUD_PROJECT: 'projeto-teste',
    GEMINI_API_KEY: 'nao-deve-ser-usada',
    GOOGLE_API_KEY: 'nao-deve-ser-usada',
  }, { checkCredentialsFile: false });
  const client = createVertexAIClient(config);
  assert.strictEqual(client.vertexai, true);
  assert.strictEqual(client.apiKey, undefined);
});

test('rejeita caminho explícito de credencial inexistente', () => {
  assert.throws(
    () => getVertexAIConfig({
      GOOGLE_CLOUD_PROJECT: 'projeto-teste',
      GOOGLE_APPLICATION_CREDENTIALS: 'Z:\\credencial-inexistente.json',
    }),
    error => error instanceof VertexAIConfigurationError
      && error.message.includes('arquivo inexistente')
  );
});
