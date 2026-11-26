// Payloads for the `needs_input` protocol.
//
// The payload is language-neutral on purpose: it carries the decision (a kind,
// numbers and stable option ids) and one English instruction for the model.
// The user-facing wording is the agent's job — CORE.md tells it to ask with
// ask_user_question in {{language}} and to translate the option labels. This
// keeps one gate implementation for every language and every future gate.
/**
 * Does the geometry-scale gate apply? A value exactly at the threshold must not
 * fire because of floating-point noise (0.1 > 0.1 is false, but 0.1000000000002
 * is not).
 */
export function scaleGateApplies(extent, askAbove) {
  const value = Number(extent)
  const above = Number(askAbove)
  if (!(above > 0) || !Number.isFinite(value)) return false
  return value > above * (1 + 1e-9)
}

export function geometryScalePrompt({ extent, askAbove }) {
  const value = Number(extent)
  return {
    kind: 'geometry-scale',
    ask: `Confirm the model units before continuing: the geometry is ${value.toFixed(3)} m across, above the ${Number(askAbove)} m threshold.`,
    data: { extent_m: Number(value.toFixed(3)), askAbove_m: Number(askAbove) },
    options: [
      { id: 'metres-ok', label: 'metres are correct, continue' },
      { id: 'millimetres', label: 'millimetres: rescale by 1e-3' },
      { id: 'other', label: 'other (I will explain)' },
    ],
  }
}
