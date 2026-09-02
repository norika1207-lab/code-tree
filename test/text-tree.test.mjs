import assert from 'node:assert/strict';
import path from 'node:path';
import { cellsFromText, scanLocalProject } from '../src/core/text-tree.js';

const textCells = cellsFromText(`file: src/demo.js
\`\`\`js
export function helloTree(name) {
  return 'hello ' + name;
}
\`\`\``);

assert.equal(textCells.length, 1);
assert.equal(textCells[0].path, 'src/demo.js');
assert.match(textCells[0].preview, /helloTree/);

const sampleRoot = path.resolve('sample');
const snap = scanLocalProject(sampleRoot);
assert.ok(snap.cells.length >= 4, `expected sample files, got ${snap.cells.length}`);
assert.ok(snap.cells.every((c) => c.preview !== undefined));
assert.equal(snap.source, 'local');

console.log(`text-tree: ${textCells.length} text box, ${snap.cells.length} project boxes`);
