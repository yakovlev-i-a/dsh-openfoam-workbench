import { join } from 'node:path'
import { readText } from './runtime.js'

export function readMakeFiles(modulePath) {
  const text = readText(join(modulePath, 'Make/files')) || ''
  const lines = text.split('\n').map((s) => s.trim()).filter(Boolean)
  const isLib = /^\s*LIB\s*=/m.test(text)
  const mainSource = lines.find((l) => /\.C$/.test(l) && !/^\s*(LIB|EXE)\s*=/.test(l)) || null
  const targetMatch = text.match(/^\s*(EXE|LIB)\s*=\s*(\S+)/m)
  return { text, isLib, mainSource, target: targetMatch ? targetMatch[2] : null }
}

export function firstError(log) {
  const lines = String(log || '').split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (/(^|\s)(error|Error):|\bundefined reference\b|make: \*\*\*|Error \d+/.test(lines[i])) {
      return lines.slice(Math.max(0, i - 2), i + 2).join('\n')
    }
  }
  return null
}

export function inspectSolverModule(modulePath) {
  const make = readMakeFiles(modulePath)
  const main = make.mainSource ? join(modulePath, make.mainSource) : null
  const code = main ? (readText(main) || '') : ''
  const header = readText(join(modulePath, 'createFields.H')) || ''
  const fields = []
  const fre = /(volScalarField|volVectorField|volTensorField|volSymmTensorField|surfaceScalarField|surfaceVectorField)\s+(\w+)/g
  let m
  while ((m = fre.exec(header)) && fields.length < 60) fields.push({ name: m[2], type: m[1] })
  const includes = []
  const ire = /#include\s+"([^"]+)"/g
  while ((m = ire.exec(code)) && includes.length < 60) includes.push(m[1])
  const loop = ['UEqn', 'pEqn', 'rhoU', 'rhoE', 'simpleControl', 'pimpleControl', 'pisoControl', 'CorrectPhi', 'fvModels', 'fvConstraints', 'thermophysicalTransport'].filter((k) => code.includes(k))
  const risks = []
  if (!make.target) risks.push('Make/files has no EXE/LIB target')
  if (!make.mainSource) risks.push('Make/files has no .C source')
  if (make.target && make.target.includes('$(FOAM_APPBIN)')) risks.push('EXE points at the system install; use $(FOAM_USER_APPBIN)')
  if (code && !/simpleControl|pimpleControl|pisoControl/.test(code)) risks.push('no simple/pimple/piso control header detected')
  return { make, fields, includes, loop, risks }
}
