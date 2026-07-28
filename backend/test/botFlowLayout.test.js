const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeLayout, validateLayoutRequest, MAX_NODES } = require('../src/services/botFlowLayout');

test('layout schema canonicalizes safe draft-only graph data', () => {
  const layout = normalizeLayout({ schema_version: 1, nodes: [
    { id: 'capture-name', kind: 'canonical', position: { x: 1.234, y: 2 }, label: ' Nombre ' },
    { id: 'draft-a', kind: 'draft', draft_only: true, type: 'capture', position: { x: 3, y: 4 }, label: ' Pregunta ', message: ' Hola ' },
  ], edges: [{ id: 'edge-a', source: 'capture-name', target: 'draft-a', draft_only: true }] });
  assert.deepEqual(layout.nodes[0].position, { x: 1.23, y: 2 });
  assert.equal(layout.nodes[1].message, 'Hola');
  assert.equal(layout.edges[0].draft_only, true);
});

test('layout schema enforces count and serialized request bounds', () => {
  assert.throws(() => normalizeLayout({ schema_version: 1, nodes: Array.from({ length: MAX_NODES + 1 }, (_, i) => ({ id: `draft-${i}`, kind: 'draft' })), edges: [] }), /máximo/);
  assert.throws(() => validateLayoutRequest({ revision: 0, layout: { schema_version: 1, nodes: [], edges: [] } }, 200000), /tamaño/);
});
