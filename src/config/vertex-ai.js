const fs = require('fs');
const { GoogleGenAI } = require('@google/genai');

const DEFAULT_VERTEX_LOCATION = 'global';
const DEFAULT_VERTEX_MODEL = 'gemini-3.5-flash';
const DEFAULT_VERTEX_API_VERSION = 'v1';

class VertexAIConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VertexAIConfigurationError';
  }
}

function cleanEnvValue(value) {
  return String(value || '').trim();
}

function getVertexAIConfig(env = process.env, options = {}) {
  const project = cleanEnvValue(env.GOOGLE_CLOUD_PROJECT);
  const location = cleanEnvValue(env.GOOGLE_CLOUD_LOCATION) || DEFAULT_VERTEX_LOCATION;
  const model = cleanEnvValue(env.VERTEX_MODEL) || DEFAULT_VERTEX_MODEL;
  const credentialsPath = cleanEnvValue(env.GOOGLE_APPLICATION_CREDENTIALS);
  const checkCredentialsFile = options.checkCredentialsFile !== false;

  if (!project) {
    throw new VertexAIConfigurationError(
      'GOOGLE_CLOUD_PROJECT é obrigatório para usar o LEIAUT com Vertex AI.'
    );
  }

  if (credentialsPath && checkCredentialsFile && !fs.existsSync(credentialsPath)) {
    throw new VertexAIConfigurationError(
      'GOOGLE_APPLICATION_CREDENTIALS aponta para um arquivo inexistente. Corrija o caminho da Service Account.'
    );
  }

  return {
    project,
    location,
    model,
    apiVersion: DEFAULT_VERTEX_API_VERSION,
    credentialsSource: credentialsPath
      ? 'Service Account via GOOGLE_APPLICATION_CREDENTIALS'
      : 'Application Default Credentials (ADC)'
  };
}

function createVertexAIClient(config = getVertexAIConfig()) {
  return new GoogleGenAI({
    vertexai: true,
    project: config.project,
    location: config.location,
    apiVersion: config.apiVersion
  });
}

function getVertexThinkingConfig(model, thinkingBudget = 0) {
  if (/^gemini-(?:3|[4-9])(?:\.|-)/.test(cleanEnvValue(model))) {
    return { thinkingLevel: 'MINIMAL', includeThoughts: false };
  }
  return {
    thinkingBudget: Math.max(0, Number(thinkingBudget) || 0),
    includeThoughts: false
  };
}

module.exports = {
  DEFAULT_VERTEX_API_VERSION,
  DEFAULT_VERTEX_LOCATION,
  DEFAULT_VERTEX_MODEL,
  VertexAIConfigurationError,
  createVertexAIClient,
  getVertexAIConfig,
  getVertexThinkingConfig
};
