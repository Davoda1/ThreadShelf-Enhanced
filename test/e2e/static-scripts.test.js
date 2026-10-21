import { describe, it } from 'node:test';
import assert from 'node:assert';
import { startApiServer } from './helpers.js';

// The UI's "copy export script" buttons fetch the browser-console scripts from the
// server's /scripts static route. Confirm they are served.
describe('static scripts route', () => {
  it('serves the OpenRouter export scripts', { timeout: 120_000 }, async () => {
    const ctx = await startApiServer({ prefix: 'threadshelf-scripts-' });
    try {
      for (const file of ['openrouter-export-all.js', 'openrouter-export-browser.js']) {
        const res = await fetch(`${ctx.baseUrl}/scripts/${file}`);
        assert.strictEqual(res.status, 200, file);
        const body = await res.text();
        assert.match(body, /platform: 'openrouter'/, file);
      }
    } catch (e) {
      e.message += `\nServer output:\n${ctx.output.join('')}`;
      throw e;
    } finally {
      await ctx.stop();
    }
  });
});
