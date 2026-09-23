const models = Object.freeze({
  'openrouter/free': { provider: 'openrouter', label: 'Free Auto · OpenRouter', env: 'OPENROUTER_API_KEY' },
  'nvidia/nemotron-nano-12b-v2-vl': { provider: 'nvidia', label: 'Nemotron Vision · NVIDIA', env: 'NVIDIA_API_KEY' },
  'meta/llama-3.3-70b-instruct': { provider: 'nvidia', label: 'Llama 3.3 70B · NVIDIA', env: 'NVIDIA_API_KEY', vision: false },
  'gemini-3.8-flash': { provider: 'gemini', label: 'Gemini 3.8 Flash', env: 'GEMINI_API_KEY' },
  'gemini-3.1-pro-preview': { provider: 'gemini', label: 'Gemini 3.1 Pro', env: 'GEMINI_API_KEY' },
  'gpt-5.6-sol': { provider: 'openai', label: 'GPT-5.6 Sol', env: 'OPENAI_API_KEY' },
  'qwen3-vl:32b': { provider: 'local', label: 'Qwen3-VL 32B on your PC' }
});

export function availableModels() {
  return Object.entries(models).map(([id, config]) => ({ id, label: config.label, provider: config.provider, vision: config.vision !== false, ready: config.provider === 'local' || !!process.env[config.env] }));
}

export function modelInfo(id) { return models[id]; }

export function parseImage(image) {
  if (image == null) return null;
  if (typeof image !== 'string' || image.length > 3_500_000) throw new Error('Image is too large');
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
  if (!match) throw new Error('Use a PNG, JPEG, or WebP image');
  const data = Buffer.from(match[2], 'base64');
  if (!data.length || data.length > 2_500_000) throw new Error('Image exceeds the 2.5 MB limit');
  const png = data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  const jpeg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  const webp = data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
  if (!({ png, jpeg, webp })[match[1]]) throw new Error('Image content does not match its type');
  return { mime: `image/${match[1]}`, base64: match[2], dataUrl: image };
}

export async function cloudAnswer(id, history, image) {
  const config = models[id];
  if (!config || config.provider === 'local' || !process.env[config.env]) throw new Error('Set up this model API key on Railway');
  if (image && config.vision === false) throw new Error('Choose a vision model for images');
  let url, headers, body;
  if (config.provider === 'gemini') {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${id}:generateContent`;
    headers = { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY };
    body = { contents: history.map((turn, index) => ({ role: turn.role === 'assistant' ? 'model' : 'user', parts: [{ text: turn.text }, ...index === history.length - 1 && image ? [{ inline_data: { mime_type: image.mime, data: image.base64 } }] : []] })), generationConfig: { maxOutputTokens: 4096 } };
  } else if (['openrouter', 'nvidia'].includes(config.provider)) {
    url = config.provider === 'openrouter' ? 'https://openrouter.ai/api/v1/chat/completions' : 'https://integrate.api.nvidia.com/v1/chat/completions';
    headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env[config.env]}` };
    body = { model: id, stream: false, max_tokens: 4096, messages: history.map((turn, index) => ({ role: turn.role, content: index === history.length - 1 && image ? [{ type: 'text', text: turn.text }, { type: 'image_url', image_url: { url: image.dataUrl } }] : turn.text })) };
  } else {
    url = 'https://api.openai.com/v1/responses';
    headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` };
    body = { model: id, store: false, max_output_tokens: 4096, input: history.map((turn, index) => ({ role: turn.role, content: turn.role === 'assistant' ? turn.text : [{ type: 'input_text', text: turn.text }, ...index === history.length - 1 && image ? [{ type: 'input_image', image_url: image.dataUrl }] : []] })) };
  }
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(110_000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 429) throw new Error('Model quota reached; check your provider account');
    if (response.status === 401 || response.status === 403) throw new Error('API key is invalid or this model is unavailable to your account');
    throw new Error(`Model provider returned status ${response.status}`);
  }
  const text = ['openrouter', 'nvidia'].includes(config.provider) ? payload.choices?.[0]?.message?.content : config.provider === 'gemini' ? payload.candidates?.[0]?.content?.parts?.filter(p => typeof p.text === 'string').map(p => p.text).join('\n') : payload.output?.flatMap(o => o.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('\n');
  if (typeof text !== 'string' || !text) throw new Error('Model returned no text response');
  return text.slice(0, 30000);
}
