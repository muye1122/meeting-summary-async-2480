/**
 * Step-level diff between two published template versions.
 *
 * Pure functions only: no I/O, no globals, no external services.
 * Steps are matched by their stable `id`. A modified step records the exact
 * field-level before/after values so an audit record can carry a diff summary.
 *
 * All step data used by the demo is SYNTHETIC.
 */

/** Fields compared by default when two steps share an id. */
export const STEP_COMPARE_FIELDS = [
  'title',
  'description',
  'assignee_role',
  'time_limit_hours',
  'skippable',
];

/** Deep copy via JSON (the template data is plain JSON in this demo). */
export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function equal(a, b) {
  if (a === b) return true;
  if (a === undefined || a === null) return b === undefined || b === null;
  if (b === undefined || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

/**
 * Compare two step arrays.
 * @returns {{added: object[], removed: object[], modified: object[], counts: object}}
 *   added   - steps present only in `afterSteps`
 *   removed - steps present only in `beforeSteps`
 *   modified - { id, changes:[{field,before,after}], before, after }
 */
export function diffSteps(beforeSteps = [], afterSteps = []) {
  const before = Array.isArray(beforeSteps) ? beforeSteps : [];
  const after = Array.isArray(afterSteps) ? afterSteps : [];
  const beforeMap = new Map(before.map((s) => [String(s?.id), s]));
  const afterMap = new Map(after.map((s) => [String(s?.id), s]));

  const added = [];
  const removed = [];
  const modified = [];

  for (const step of after) {
    const id = String(step?.id);
    if (!beforeMap.has(id)) {
      added.push(clone(step));
      continue;
    }
    const previous = beforeMap.get(id);
    const changes = [];

    for (const field of STEP_COMPARE_FIELDS) {
      if (!equal(previous?.[field], step?.[field])) {
        changes.push({ field, before: previous?.[field] ?? null, after: step?.[field] ?? null });
      }
    }
    // Catch any additional JSON field that is not part of the default list.
    const keys = new Set([...Object.keys(previous || {}), ...Object.keys(step || {})]);
    for (const key of keys) {
      if (key === 'id' || key === 'status' || STEP_COMPARE_FIELDS.includes(key)) continue;
      if (!equal(previous?.[key], step?.[key])) {
        changes.push({ field: key, before: previous?.[key] ?? null, after: step?.[key] ?? null });
      }
    }

    if (changes.length) {
      modified.push({ id, changes, before: clone(previous), after: clone(step) });
    }
  }

  for (const step of before) {
    const id = String(step?.id);
    if (!afterMap.has(id)) removed.push(clone(step));
  }

  return {
    added,
    removed,
    modified,
    counts: { added: added.length, removed: removed.length, modified: modified.length },
  };
}

/** Empty diff, used when a template is disabled (no step changes). */
export function emptyDiff() {
  return { added: [], removed: [], modified: [], counts: { added: 0, removed: 0, modified: 0 } };
}

/** Human-readable one-line diff text containing all three categories. */
export function summarizeDiff(diff) {
  const d = diff && typeof diff === 'object' ? diff : emptyDiff();
  const addedIds = (d.added || []).map((s) => s?.id).join(', ') || '无';
  const removedIds = (d.removed || []).map((s) => s?.id).join(', ') || '无';
  const modifiedText = (d.modified || []).map((m) => {
    const fields = (m.changes || []).map((c) => `${c.field} ${c.before} → ${c.after}`).join('; ');
    return `${m.id}(${fields})`;
  }).join(', ') || '无';
  return `新增 ${d.added?.length || 0} 步[${addedIds}] / 删除 ${d.removed?.length || 0} 步[${removedIds}] / 修改 ${d.modified?.length || 0} 步[${modifiedText}]`;
}

/**
 * Structured diff summary stored in an audit record. Keeps both the three
 * step lists (added/removed/modified) and the readable text.
 */
export function diffSummary(diff, meta = {}) {
  const d = diff && typeof diff === 'object' ? diff : emptyDiff();
  return {
    from_version: meta.from_version ?? null,
    to_version: meta.to_version ?? null,
    added: (d.added || []).map((s) => ({ id: s?.id ?? null, title: s?.title ?? null })),
    removed: (d.removed || []).map((s) => ({ id: s?.id ?? null, title: s?.title ?? null })),
    modified: (d.modified || []).map((m) => ({
      id: m.id,
      fields: (m.changes || []).map((c) => c.field),
      changes: clone(m.changes || []),
    })),
    counts: clone(d.counts || { added: 0, removed: 0, modified: 0 }),
    text: summarizeDiff(d),
  };
}
