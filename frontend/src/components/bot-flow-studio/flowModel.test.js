import { describe, expect, it } from 'vitest';
import { activeEdgeIds, buildStudioGraph, canConnectDraft, connectDraft, definitionEdges, deleteDraftEdge, deleteDraftNode, draftConnectionError, draftEdge, layoutDepths, makeDraftNode, reconnectDraft, selectScopedFlow, validateDraft } from './flowModel';

const definition = {
  entry_node_id: 'start',
  nodes: [
    { node_id: 'start', runtime_type: 'entry', label: 'Inicio', next: null, branches: [{ branch_id: 'yes', label: 'Sí', target: 'question' }, { branch_id: 'no', label: 'No', target: 'end' }] },
    { node_id: 'question', runtime_type: 'capture', label: 'Pregunta', next: 'end', branches: [] },
    { node_id: 'end', runtime_type: 'terminal', label: 'Fin', next: null, branches: [] },
  ],
};

describe('flowModel', () => {
  it('maps canonical edges and preserves branch labels', () => {
    expect(definitionEdges(definition)).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'start', target: 'question', label: 'Sí', data: { locked: true } }),
      expect.objectContaining({ source: 'start', target: 'end', label: 'No' }),
    ]));
  });

  it('lays out nodes by traversal depth rather than runtime type', () => {
    const depths = layoutDepths(definition);
    expect([...depths.entries()]).toEqual(expect.arrayContaining([['start', 0], ['question', 1], ['end', 1]]));
    const graph = buildStudioGraph(definition);
    expect(graph.nodes.find(node => node.id === 'question').position.x).toBe(graph.nodes.find(node => node.id === 'end').position.x);
  });

  it('marks only edges traversed by the active path', () => {
    expect([...activeEdgeIds(['start', 'question', 'end'])]).toEqual(['start:question', 'question:end']);
  });

  it('selects a message only inside the active version and area scope', () => {
    const flows = [{ id: 1, step_key: 'ask', version_id: 1, area_id: null }, { id: 2, step_key: 'ask', version_id: 2, area_id: 9 }];
    expect(selectScopedFlow(flows, 'ask', 2, 9)?.id).toBe(2);
    expect(selectScopedFlow(flows, 'ask', 2, null)).toBeNull();
  });

  it('allows draft routes out of canonical nodes without allowing incoming canonical rewrites', () => {
    const graph = buildStudioGraph(definition);
    const draft = { id: 'draft-question', data: { canonical: false, runtime_type: 'terminal', displayLabel: 'Draft end' } };
    const nodes = [...graph.nodes, draft];
    expect(canConnectDraft(nodes, { source: 'start', target: draft.id })).toBe(true);
    expect(canConnectDraft(nodes, { source: draft.id, target: 'end' })).toBe(false);
    const edge = draftEdge({ source: 'start', target: draft.id });
    expect(edge.data).toMatchObject({ locked: false, draft: true });
    expect(validateDraft(nodes, [...graph.edges, edge], 'start')).toEqual([]);
  });

  it('explains self, duplicate, terminal and protected incoming connection errors', () => {
    const graph = buildStudioGraph(definition);
    const first = makeDraftNode('capture', 1);
    const terminal = makeDraftNode('terminal', 2);
    const nodes = [...graph.nodes, first, terminal];
    const edge = draftEdge({ source: 'start', target: first.id });
    expect(draftConnectionError(nodes, [], { source: first.id, target: first.id })).toMatch(/consigo mismo/i);
    expect(draftConnectionError(nodes, [edge], { source: 'start', target: first.id })).toMatch(/ya existe/i);
    expect(draftConnectionError(nodes, [], { source: terminal.id, target: first.id })).toMatch(/Finalizar/i);
    expect(draftConnectionError(nodes, [], { source: first.id, target: 'end' })).toMatch(/protegidas/i);
  });

  it('requires Sí and No routes for draft decisions', () => {
    const decision = makeDraftNode('decision', 1);
    const yes = makeDraftNode('terminal', 2);
    const no = makeDraftNode('terminal', 3);
    const nodes = [decision, yes, no];
    const yesEdge = draftEdge({ source: decision.id, target: yes.id }, { id: 'yes', label: 'Sí', color: '#35d3c8' });
    expect(validateDraft(nodes, [yesEdge]).some(issue => /ruta “No”/.test(issue.text))).toBe(true);
    const noEdge = draftEdge({ source: decision.id, target: no.id }, { id: 'no', label: 'No', color: '#ef7883' });
    expect(validateDraft(nodes, [yesEdge, noEdge]).filter(issue => /necesita la ruta/.test(issue.text))).toHaveLength(0);
  });

  it('rejects repeated decision routes and reports duplicate branches clearly', () => {
    const decision = makeDraftNode('decision', 1);
    const first = makeDraftNode('capture', 2);
    const second = makeDraftNode('terminal', 3);
    const yesRoute = { id: 'yes', label: 'Sí', color: '#35d3c8' };
    const firstYes = draftEdge({ source: decision.id, target: first.id }, yesRoute);
    expect(draftConnectionError([decision, first, second], [firstYes], { source: decision.id, target: second.id }, yesRoute)).toMatch(/ya tiene una ruta “Sí”/i);
    const issues = validateDraft([decision, first, second], [firstYes, draftEdge({ source: decision.id, target: second.id }, yesRoute)]);
    expect(issues.some(issue => /más de una ruta “Sí”/i.test(issue.text))).toBe(true);
  });

  it('requires guided route metadata for every connection sourced by a decision', () => {
    const decision = makeDraftNode('decision', 1);
    const target = makeDraftNode('capture', 2);
    expect(draftConnectionError([decision, target], [], { source: decision.id, target: target.id })).toMatch(/asistente.*ruta/i);
    expect(canConnectDraft([decision, target], { source: decision.id, target: target.id })).toBe(false);
  });

  it('validates reconnect against other edges without conflicting with itself', () => {
    const decision = makeDraftNode('decision', 1);
    const first = makeDraftNode('capture', 2);
    const second = makeDraftNode('terminal', 3);
    const third = makeDraftNode('capture', 4);
    const yes = draftEdge({ source: decision.id, target: first.id }, { id: 'yes', label: 'Sí' });
    const no = draftEdge({ source: decision.id, target: second.id }, { id: 'no', label: 'No' });
    const movedYes = reconnectDraft([decision, first, second, third], [yes, no], yes.id, { source: decision.id, target: third.id });
    expect(movedYes).toEqual([expect.objectContaining({ id: yes.id, source: decision.id, target: third.id, label: 'Sí', data: expect.objectContaining({ branch_id: 'yes' }) }), no]);
    const duplicateYes = draftEdge({ source: decision.id, target: second.id }, { id: 'yes', label: 'Sí' });
    expect(reconnectDraft([decision, first, second], [yes, duplicateYes], yes.id, { source: decision.id, target: first.id })).toEqual([yes, duplicateYes]);
  });

  it('covers add, connect, reconnect, edge deletion, and node deletion contracts', () => {
    const graph = buildStudioGraph(definition);
    const first = makeDraftNode('capture', 1, { x: 10, y: 20 });
    const second = makeDraftNode('terminal', 2, { x: 30, y: 40 });
    const nodes = [...graph.nodes, first, second];
    const connected = connectDraft(nodes, graph.edges, { source: 'start', target: first.id });
    const draft = connected.at(-1);
    expect(draft.data.draft).toBe(true);
    const reconnected = reconnectDraft(nodes, connected, draft.id, { source: 'start', target: second.id });
    expect(reconnected.at(-1)).toMatchObject({ source: 'start', target: second.id });
    expect(deleteDraftEdge(reconnected, draft.id)).toHaveLength(graph.edges.length);
    const deleted = deleteDraftNode(nodes, reconnected, second.id);
    expect(deleted.nodes).not.toContainEqual(expect.objectContaining({ id: second.id }));
    expect(deleted.edges).not.toContainEqual(expect.objectContaining({ target: second.id }));
    expect(deleteDraftNode(nodes, graph.edges, 'start').nodes).toBe(nodes);
  });

  it('keeps node movement snapshots reversible for undo and redo', () => {
    const node = makeDraftNode('capture', 3, { x: 10, y: 20 });
    const before = { nodes: [node], edges: [] };
    const after = { nodes: [{ ...node, position: { x: 90, y: 120 } }], edges: [] };
    const history = { past: [before], future: [] };
    const undo = history.past.pop();
    history.future.push(after);
    expect(undo.nodes[0].position).toEqual({ x: 10, y: 20 });
    const redo = history.future.pop();
    history.past.push(undo);
    expect(redo.nodes[0].position).toEqual({ x: 90, y: 120 });
  });
});
