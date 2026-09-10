require('dotenv').config();
const assert = require('assert');

async function main() {
  const separator = process.argv.indexOf('--');
  const query = process.argv.slice(2, separator === -1 ? undefined : separator).join(' ').trim();
  const expected = separator === -1 ? [] : process.argv.slice(separator + 1);
  if (!query) throw new Error('Usage: node scripts/test-section-query.js <query> -- <expected heading> [...]');

  const login = await fetch('http://localhost:3000/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'user', code: process.env.USER_ACCESS_CODE || '' })
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  assert(cookie, 'Login session cookie was not returned');

  const response = await fetch('http://localhost:3000/api/chat/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ query })
  });
  const result = await response.json();
  console.log(JSON.stringify({ grounded: result.grounded, sources: result.sources, chunkCount: result.chunks.length, answer: result.answer, intent: result.intent }, null, 2));
  assert(result.grounded, `Expected a grounded answer, received: ${result.answer}`);
  for (const heading of expected) {
    assert(result.answer.includes(heading), `Expected heading missing from answer: ${heading}`);
  }
  console.log('section query: PASS');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
