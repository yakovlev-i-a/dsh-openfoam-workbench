// Payloads for the `needs_input` protocol.
//
// The payload is language-neutral on purpose: it carries the decision (a kind,
// numbers and stable option ids) and one English instruction for the model.
// The user-facing wording is the agent's job — CORE.md tells it to ask with
// ask_user_question in {{language}} and to translate the option labels. This
// keeps one gate implementation for every language and every future gate.
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
