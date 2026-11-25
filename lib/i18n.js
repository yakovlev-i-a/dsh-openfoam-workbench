// Human-facing strings the tools must produce in the user's language.
//
// The agent's own prose is governed by CORE.md ({{language}}), but a tool result
// that asks the user a question carries text the model should not translate on
// its own: the geometry-scale gate. Both places that raise it (mesh_plan and
// check) use one template per language, so the question is identical wherever
// it appears.
const SCALE_GATE = {
  Russian: {
    question: (extent) =>
      `Геометрия ${extent} м. Это действительно метры, или модель строилась в миллиметрах и её забыли отмасштабировать?`,
    options: ['метры верны, продолжаем', 'миллиметры: умножить геометрию на 1e-3', 'другое (объясню)'],
  },
  English: {
    question: (extent) =>
      `The geometry is ${extent} m across. Are these really metres, or was the model built in millimetres and never rescaled?`,
    options: ['metres are correct, continue', 'millimetres: rescale by 1e-3', 'other (I will explain)'],
  },
}

const DEFAULT_LANGUAGE = 'English'

/** The template set for a resolved language name; unknown languages use English. */
export function templatesFor(language) {
  return SCALE_GATE[String(language || '')] || SCALE_GATE[DEFAULT_LANGUAGE]
}

/**
 * The `needs_input` payload for the geometry-scale gate.
 * `extent` is the largest bounding-box dimension in metres.
 */
export function scaleGate(language, extent) {
  const t = templatesFor(language)
  const value = Number(extent).toFixed(3)
  return { question: t.question(value), options: [...t.options] }
}
