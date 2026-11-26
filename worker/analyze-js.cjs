const { readFile, stat } = require('node:fs/promises')
const { parse } = require('@babel/parser')
const generate = require('@babel/generator').default
const traverse = require('@babel/traverse').default

const inputLimit = 4 * 1024 * 1024
const codeLimit = 900_000
const shaderLimit = 100
const shaderSizeLimit = 32_768

function shaderStage(text) {
  if (!/\bvoid\s+main\s*\(/.test(text)) return null
  if (/\bgl_Position\s*=/.test(text)) return 'vertex'
  if (/\b(?:gl_FragColor|gl_FragData|out\s+vec4)\b/.test(text)) return 'fragment'
  return null
}

function staticText(node) {
  if (node.type === 'StringLiteral') return node.value
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked
  return null
}

function propertyName(node) {
  return node?.key?.name ?? node?.key?.value
}

function functionName(path) {
  const scope = path.getFunctionParent()
  const name = scope?.node.id?.name ?? propertyName(scope?.node) ?? scope?.parentPath?.node.id?.name
  return typeof name === 'string' ? name : null
}

function extractShaders(ast) {
  const shaders = []
  const seen = new Set()
  let total = 0

  function visit(path) {
    const text = staticText(path.node)
    const stage = text && shaderStage(text)
    if (!stage || seen.has(text)) return
    seen.add(text)
    total++
    if (shaders.length >= shaderLimit) return

    const parent = path.parentPath
    const variable = parent.isVariableDeclarator() && parent.node.id.type === 'Identifier' ? parent.node.id.name : null
    const references = variable ? parent.scope.getBinding(variable)?.referencePaths ?? [] : []
    const property = stage === 'vertex' ? 'vertexShader' : 'fragmentShader'
    const shaderReferences = references.filter(reference =>
      reference.parentPath.isObjectProperty({ value: reference.node }) &&
      propertyName(reference.parentPath.node) === property,
    )
    const paths = shaderReferences.length ? shaderReferences : references.length ? references : [path]
    const name = parent.isObjectProperty() ? propertyName(parent.node) : variable
    shaders.push({
      name: typeof name === 'string' ? name : null,
      stage,
      line: path.node.loc.start.line,
      code: text.slice(0, shaderSizeLimit),
      truncated: text.length > shaderSizeLimit,
      references: paths.slice(0, 12).map(reference => ({
        loc: reference.node.loc.start,
        label: functionName(reference) ?? property,
      })),
    })
  }

  traverse(ast, { StringLiteral: visit, TemplateLiteral: visit })
  return { shaders, shaderCount: total }
}

function linkUsages(shaders, mappings, code) {
  const requested = new Set(shaders.flatMap(shader => shader.references.map(({ loc }) => `${loc.line}:${loc.column}`)))
  const lines = new Map()
  for (const mapping of mappings) {
    if (!mapping.original) continue
    const key = `${mapping.original.line}:${mapping.original.column}`
    if (requested.has(key) && !lines.has(key)) lines.set(key, mapping.generated.line)
  }
  const lastLine = code.split('\n').length
  return shaders.map(({ references, ...shader }) => {
    const usages = new Map()
    for (const { loc, label } of references) {
      const line = lines.get(`${loc.line}:${loc.column}`)
      if (line && line <= lastLine) usages.set(line, { line, label })
    }
    return { ...shader, usages: [...usages.values()] }
  })
}

async function analyzeJavaScript(file) {
  const details = await stat(file)
  if (!details.isFile() || details.size > inputLimit) {
    throw new Error('Для разбора JavaScript выбери файл до 4 МБ.')
  }
  const source = await readFile(file, 'utf8')
  let ast
  try {
    ast = parse(source, { sourceType: 'unambiguous', allowReturnOutsideFunction: true })
  } catch (error) {
    const line = error.loc?.line
    throw new Error(line ? `Не удалось разобрать JavaScript. Синтаксическая ошибка на строке ${line}.` : 'Не удалось разобрать JavaScript.')
  }
  const mapping = (ast.comments ?? []).map(comment => /[#@]\s*sourceMappingURL\s*=\s*(\S+)/.exec(comment.value)?.[1])
    .filter(Boolean).at(-1)
  const { shaders, shaderCount } = extractShaders(ast)
  const output = generate(ast, { compact: false, minified: false, sourceMaps: shaders.length > 0, sourceFileName: 'bundle.js' })
  const code = output.code.slice(0, codeLimit)
  return {
    code,
    truncated: output.code.length > codeLimit,
    sourceMap: mapping ? (mapping.startsWith('data:') ? 'inline' : 'linked') : null,
    shaderCount,
    shaders: linkUsages(shaders, output.rawMappings ?? [], code),
  }
}

module.exports = { analyzeJavaScript }
