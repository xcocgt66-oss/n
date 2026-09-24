const models = {
  'openrouter/free': {
    provider: 'openrouter',
    label: 'Free Auto · OpenRouter',
    env: 'OPENROUTER_API_KEY'
  },
  'gemini/auto': {
    provider: 'gemini',
    label: 'Gemini Auto',
    env: 'GEMINI_API_KEY',
    auto: true
  },
  'nvidia/auto': {
    provider: 'nvidia',
    label: 'NVIDIA Auto',
    env: 'NVIDIA_API_KEY',
    auto: true
  },
  'openai/auto': {
    provider: 'openai',
    label: 'OpenAI Auto',
    env: 'OPENAI_API_KEY',
    auto: true
  }
};

const providers = {
  gemini: {
    env: 'GEMINI_API_KEY',
    url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000'
  },
  nvidia: {
    env: 'NVIDIA_API_KEY',
    url: 'https://integrate.api.nvidia.com/v1/models'
  },
  openai: {
    env: 'OPENAI_API_KEY',
    url: 'https://api.openai.com/v1/models'
  },
  openrouter: {
    env: 'OPENROUTER_API_KEY',
    url: 'https://openrouter.ai/api/v1/models'
  }
};

let expires = 0;
let refreshing;
const catalogErrors = {};

export function modelDiagnostics() {
  return { ...catalogErrors };
}

function providerError(provider, status, payload = {}) {
  const reasons = {
    401: 'API key rejected',
    403: 'Access denied for this account',
    404: 'Model or endpoint not available',
    410: 'Model or endpoint retired or unavailable',
    429: 'Quota or rate limit reached',
    503: 'Provider temporarily unavailable; retry later'
  };

  let detail = String(
    payload.error?.message || payload.message || ''
  ).slice(0, 500);

  for (const { env } of Object.values(providers)) {
    if (process.env[env]) {
      detail = detail.split(process.env[env]).join('[redacted]');
    }
  }

  detail = detail.replace(
    /(?:https?:\/\/|Bearer\s+|sk-)[^\s]+/gi,
    '[redacted]'
  );

  const error = new Error(
    `${provider}: ${reasons[status] || 'Provider request failed'} ` +
    `(HTTP ${status})${detail ? ': ' + detail : ''}`
  );

  error.status = status;
  return error;
}

export async function refreshModels(force = false) {
  if (refreshing) return refreshing;
  if (!force && Date.now() < expires) return;

  refreshing = Promise.all(
    Object.entries(providers).map(async ([provider, cfg]) => {
      const key = process.env[cfg.env]?.trim();
      if (!key) return;

      try {
        const headers = provider === 'gemini'
          ? { 'x-goog-api-key': key }
          : { Authorization: `Bearer ${key}` };

        const response = await fetch(cfg.url, {
          headers,
          signal: AbortSignal.timeout(12000)
        });

        const payload = await response.json();

        if (!response.ok) {
          throw providerError(provider, response.status, payload);
        }

        const rows = provider === 'gemini'
          ? payload.models
          : payload.data;

        if (!Array.isArray(rows)) {
          throw new Error(`${provider}: Invalid model catalog`);
        }

        const next = {};

        for (const row of rows) {
          const remoteId = (row.id || row.name || '')
            .replace(/^models\//, '');

          let accept = false;
          let vision = false;

          if (provider === 'gemini') {
            accept = remoteId.startsWith('gemini-') &&
              row.supportedGenerationMethods?.includes('generateContent') &&
              !/image|tts|robotics|computer-use/.test(remoteId);

            vision = true;
          }

          if (provider === 'nvidia') {
            accept = /instruct|nemotron|deepseek|qwen|gpt-oss/i.test(remoteId) &&
              !/embed|rerank|reward|guard|retriev|parse|speech|audio/i.test(remoteId);

            vision = /(?:-vl(?:-|$)|vision|llama-3\.2-(?:11|90)b)/i.test(remoteId);
          }

          if (provider === 'openai') {
            accept = /^(gpt-[456](?:[.-]|$)|o[34](?:-|$))/.test(remoteId) &&
              !/audio|realtime|transcribe|tts|image|search|codex|research|chat-latest|instruct/.test(remoteId);

            vision = accept;
          }

          if (provider === 'openrouter') {
            accept = remoteId.endsWith(':free') &&
              row.architecture?.output_modalities?.includes('text');

            vision = row.architecture?.input_modalities?.includes('image') === true;
          }

          if (!accept) continue;

          next[`${provider}:${remoteId}`] = {
            provider,
            remoteId,
            env: cfg.env,
            label: `${row.displayName || row.name || remoteId} · ${provider}`,
            vision
          };
        }

        for (const [id, value] of Object.entries(models)) {
          if (
            value.provider === provider &&
            id !== 'openrouter/free' &&
            !value.auto
          ) {
            delete models[id];
          }
        }

        Object.assign(models, next);
        delete catalogErrors[provider];

        if (!Object.keys(next).length && provider !== 'openrouter') {
          catalogErrors[provider] = 'No compatible chat models returned';
        }
      } catch (error) {
        catalogErrors[provider] = error.message;
      }
    })
  ).finally(() => {
    expires = Date.now() + 5 * 60_000;
    refreshing = undefined;
  });

  return refreshing;
}

export function availableModels() {
  return Object.entries(models).map(([id, config]) => ({
    id,
    label: config.label,
    provider: config.provider,
    vision: config.vision !== false,
    ready: config.provider === 'local' || !!process.env[config.env]
  }));
}

export function modelInfo(id) {
  return Object.hasOwn(models, id) ? models[id] : undefined;
}

export function parseImage(image) {
  if (image == null) return null;

  if (typeof image !== 'string' || image.length > 3_500_000) {
    throw new Error('Image is too large');
  }

  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);

  if (!match) {
    throw new Error('Use a PNG, JPEG, or WebP image');
  }

  const data = Buffer.from(match[2], 'base64');

  if (!data.length || data.length > 2_500_000) {
    throw new Error('Image exceeds the 2.5 MB limit');
  }

  const png = data.subarray(0, 8).equals(
    Buffer.from('89504e470d0a1a0a', 'hex')
  );

  const jpeg = data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff;

  const webp = data.toString('ascii', 0, 4) === 'RIFF' &&
    data.toString('ascii', 8, 12) === 'WEBP';

  if (!({ png, jpeg, webp })[match[1]]) {
    throw new Error('Image content does not match its type');
  }

  return {
    mime: `image/${match[1]}`,
    base64: match[2],
    dataUrl: image
  };
}

async function generate(id, history, image, signal) {
  const config = modelInfo(id);

  if (!config || config.provider === 'local' || !process.env[config.env]) {
    throw new Error('Set up this model API key on Railway');
  }

  if (image && config.vision === false) {
    throw new Error('Choose a vision model for images');
  }

  const remoteId = config.remoteId || id;
  let url;
  let headers;
  let body;

  if (config.provider === 'gemini') {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(remoteId)}:generateContent`;

    headers = {
      'Content-Type': 'application/json',
      'x-goog-api-key': process.env.GEMINI_API_KEY.trim()
    };

    body = {
      contents: history.map((turn, index) => ({
        role: turn.role === 'assistant' ? 'model' : 'user',
        parts: [
          { text: turn.text },
          ...(index === history.length - 1 && image
            ? [{
                inline_data: {
                  mime_type: image.mime,
                  data: image.base64
                }
              }]
            : [])
        ]
      })),
      generationConfig: {
        maxOutputTokens: 4096
      }
    };
  } else if (['openrouter', 'nvidia'].includes(config.provider)) {
    url = config.provider === 'openrouter'
      ? 'https://openrouter.ai/api/v1/chat/completions'
      : 'https://integrate.api.nvidia.com/v1/chat/completions';

    headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env[config.env].trim()}`
    };

    body = {
      model: remoteId,
      stream: false,
      max_tokens: 4096,
      messages: history.map((turn, index) => ({
        role: turn.role,
        content: index === history.length - 1 && image
          ? [
              { type: 'text', text: turn.text },
              {
                type: 'image_url',
                image_url: { url: image.dataUrl }
              }
            ]
          : turn.text
      }))
    };
  } else {
    url = 'https://api.openai.com/v1/responses';

    headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY.trim()}`
    };

    body = {
      model: remoteId,
      store: false,
      max_output_tokens: 4096,
      input: history.map((turn, index) => ({
        role: turn.role,
        content: turn.role === 'assistant'
          ? turn.text
          : [
              { type: 'input_text', text: turn.text },
              ...(index === history.length - 1 && image
                ? [{
                    type: 'input_image',
                    image_url: image.dataUrl
                  }]
                : [])
            ]
      }))
    };
  }

  let payload;

  for (let attempt = 0; attempt < 3; attempt++) {
    let response;

    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal
      });

      payload = await response.json().catch(() => ({}));
    } catch {
      throw new Error(
        `${config.provider}: Connection failed or request timed out; try again`
      );
    }

    if (response.ok) break;

    if ([502, 503, 504].includes(response.status) && attempt < 2) {
      await new Promise(resolve => {
        setTimeout(resolve, 1000 * 2 ** attempt);
      });

      continue;
    }

    if ([404, 410].includes(response.status)) {
      delete models[id];

      catalogErrors[config.provider] =
        `${remoteId}: unavailable (HTTP ${response.status})`;
    }

    throw providerError(config.provider, response.status, payload);
  }

  const text = ['openrouter', 'nvidia'].includes(config.provider)
    ? payload.choices?.[0]?.message?.content
    : config.provider === 'gemini'
      ? payload.candidates?.[0]?.content?.parts
          ?.filter(part => typeof part.text === 'string')
          .map(part => part.text)
          .join('\n')
      : payload.output
          ?.flatMap(output => output.content || [])
          .filter(content => content.type === 'output_text')
          .map(content => content.text)
          .join('\n');

  if (typeof text !== 'string' || !text) {
    throw new Error('Model returned no text response');
  }

  return text.slice(0, 30000);
}

export async function cloudAnswer(id, history, image) {
  const config = modelInfo(id);

  if (!config || !process.env[config.env]?.trim()) {
    throw new Error('Configure the provider API key in Railway');
  }

  const signal = AbortSignal.timeout(110000);

  if (!config.auto) {
    return generate(id, history, image, signal);
  }

  await refreshModels();

  const candidates = Object.entries(models)
    .filter(([, item]) => (
      item.provider === config.provider &&
      !item.auto &&
      (!image || item.vision === true)
    ))
    .sort(([a], [b]) => (
      Number(/flash|nemotron|4o|4\.1/i.test(b)) -
      Number(/flash|nemotron|4o|4\.1/i.test(a))
    ))
    .slice(0, 3);

  if (!candidates.length) {
    throw new Error(
      catalogErrors[config.provider] ||
      `${config.provider}: No compatible models found for this request`
    );
  }

  let lastError;

  for (const [candidate] of candidates) {
    if (signal.aborted) break;

    try {
      return await generate(candidate, history, image, signal);
    } catch (error) {
      lastError = error;

      if (![404, 410, 502, 503, 504].includes(error.status)) {
        throw error;
      }
    }
  }

  throw lastError || new Error(
    `${config.provider}: Request timed out`
  );
}
