'use strict';
// vsce package turns every "#123" in README.md and CHANGELOG.md into a link to this repo's issue 123.
// Inside a link to another project's issue that makes a nested link that points to a missing issue here.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

for (const name of ['README.md', 'CHANGELOG.md']) {
  test(`${name} has no bare #number that vsce would link to this repo's issues`, () => {
    const text = fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
    const hits = text.split('\n').filter(l => /(^|[\s(\[])#\d+\b/.test(l));
    assert.deepStrictEqual(hits, []);
  });
}
