// Pure projection used by regression tests. Installed status reader is rendered
// from templates/tokyo-status-input.mjs.in with the recipient's local context.
export const selectedProbes = gate => Array.isArray(gate.probes) ? gate.probes
  .filter(p => p?.lane === gate.selectedLane)
  .map(p => ({ lane:p.lane,at:p.at,outcome:p.outcome })) : [];
