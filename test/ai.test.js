import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudAnswer, modelInfo, parseImage } from '../ai.js';

test('OpenRouter and NVIDIA forward vision inputs and extract replies', async () => {
  const original = globalThis.fetch;
  const oldNvidia = process.env.NVIDIA_API_KEY;
  const oldRouter = process.env.OPENROUTER_API_KEY;
  process.env.NVIDIA_API_KEY = 'test-only';
  process.env.OPENROUTER_API_KEY = 'test-only';
  const image = parseImage('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB');
  try {
    globalThis.fetch = async (url, options) => {
      assert.match(url, /^https:\/\/(openrouter.ai\/api|integrate.api.nvidia.com)\/v1\/chat\/completions$/);
      const body = JSON.parse(options.body);
      assert.equal(body.messages[0].content[1].image_url.url, image.dataUrl);
      assert.equal(body.stream, false);
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'إجابة بالعربية' } }] }) };
    };
    for (const id of ['openrouter/free', 'nvidia/nemotron-nano-12b-v2-vl']) assert.equal(await cloudAnswer(id, [{ role: 'user', text: 'اشرح الصورة' }], image), 'إجابة بالعربية');
    assert.equal(modelInfo('meta/llama-3.3-70b-instruct').vision, false);
    await assert.rejects(cloudAnswer('meta/llama-3.3-70b-instruct', [{ role: 'user', text: 'image' }], image), /vision/);
    assert.throws(() => parseImage('data:image/png;base64,AAAA'));
  } finally {
    globalThis.fetch = original;
    if (oldNvidia === undefined) delete process.env.NVIDIA_API_KEY; else process.env.NVIDIA_API_KEY = oldNvidia;
    if (oldRouter === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldRouter;
  }
});
