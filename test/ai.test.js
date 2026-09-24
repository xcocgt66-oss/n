import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudAnswer, modelInfo, parseImage, refreshModels, availableModels, ACCURACY_POLICY } from '../ai.js';

test('curated catalog, free-only routing, accuracy instructions and provider recovery', async () => {
  const original = globalThis.fetch;
  const names = ['NVIDIA_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY'];
  const previous = names.map(name => process.env[name]);
  names.forEach(name => process.env[name] = 'test-secret');
  const image = parseImage('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB');
  const result = payload => ({ ok: true, json: async () => payload });
  const gemma = 'google/gemma-4-31b-it:free';
  try {
    globalThis.fetch = async url => {
      if (url.includes('googleapis')) return result({ models: [{ name: 'models/gemini-test', supportedGenerationMethods: ['generateContent'] }] });
      if (url.includes('openrouter')) return result({ data: [
        { id: gemma, pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
        { id: 'stealth/space-bunny-alpha', pricing: { prompt: '.01', completion: '0' }, architecture: { input_modalities: ['image'], output_modalities: ['text'] } }
      ] });
      if (url.includes('nvidia')) throw Error('Pinned NVIDIA model should not depend on discovery');
      return result({ data: [{ id: 'gpt-4.1' }] });
    };
    await refreshModels(true);
    assert.equal(modelInfo('toString'), undefined);
    assert.equal(modelInfo('qwen3-vl:32b'), undefined);
    assert.equal(modelInfo('nvidia/auto'), undefined);
    assert.ok(availableModels().find(m => m.id === 'openrouter:' + gemma).ready);
    assert.equal(availableModels().find(m => m.id.includes('space-bunny')).ready, false);
    assert.equal(availableModels().find(m => m.id.includes('kimi')).ready, false);
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      if (url.includes('googleapis')) {
        assert.equal(body.systemInstruction.parts[0].text, ACCURACY_POLICY);
        assert.equal(body.contents[0].parts[1].inline_data.data, image.base64);
        return result({ candidates: [{ content: { parts: [{ thought: true, text: 'private reasoning' }, { text: 'إجابة' }] } }] });
      }
      if (url.includes('api.openai.com')) {
        assert.equal(body.instructions, ACCURACY_POLICY);
        return result({ output: [{ content: [{ type: 'output_text', text: 'إجابة' }] }] });
      }
      assert.equal(body.messages[0].role, 'system');
      assert.equal(body.messages[0].content, ACCURACY_POLICY);
      if (url.includes('openrouter')) {
        assert.deepEqual(body.provider.max_price, { prompt: 0, completion: 0 });
        assert.equal(body.messages[1].content[1].image_url.url, image.dataUrl);
      } else {
        assert.equal(body.model, 'nvidia/nemotron-3-ultra-550b-a55b');
        assert.equal(body.chat_template_kwargs.enable_thinking, true);
      }
      return result({ choices: [{ message: { content: 'إجابة' } }] });
    };
    for (const id of ['openrouter/free', 'openrouter:' + gemma, 'gemini/auto', 'openai:gpt-4.1']) assert.equal(await cloudAnswer(id, [{ role: 'user', text: 'اشرح' }], image), 'إجابة');
    const nvidia = 'nvidia:nvidia/nemotron-3-ultra-550b-a55b';
    assert.equal(await cloudAnswer(nvidia, [{ role: 'user', text: 'مرحبا' }]), 'إجابة');
    await assert.rejects(cloudAnswer(nvidia, [{ role: 'user', text: 'اشرح' }], image), /vision/);
    await assert.rejects(cloudAnswer('openrouter:moonshotai/kimi-vl-a3b-thinking:free', [{ role: 'user', text: 'Hi' }]), /Unavailable/);
    let attempts = 0;
    globalThis.fetch = async () => ++attempts < 3 ? { ok: false, status: 503, json: async () => ({}) } : result({ candidates: [{ content: { parts: [{ text: 'recovered' }] } }] });
    assert.equal(await cloudAnswer('gemini/auto', [{ role: 'user', text: 'hello' }]), 'recovered');
    assert.equal(attempts, 3);
    globalThis.fetch = async () => ({ ok: false, status: 410, json: async () => ({ error: { message: 'Retired test-secret' } }) });
    await assert.rejects(cloudAnswer('gemini:gemini-test', [{ role: 'user', text: 'Hi' }]), error => /HTTP 410/.test(error.message) && !error.message.includes('test-secret'));
    assert.throws(() => parseImage('data:image/png;base64,AAAA'));
  } finally {
    globalThis.fetch = original;
    names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; });
  }
});
