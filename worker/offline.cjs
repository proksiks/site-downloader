const { copyFile, link, mkdir, readFile, rm, writeFile } = require('node:fs/promises')
const { dirname, extname, posix, join } = require('node:path')
const { parse, parseFragment, serialize, defaultTreeAdapter } = require('parse5')
const postcss = require('postcss')
const valueParser = require('postcss-value-parser')
const parseSrcset = require('parse-srcset')
const { previewExtension } = require('./archive-paths.cjs')

const removeTags = new Set(['script', 'base', 'iframe', 'frame', 'object', 'embed', 'applet', 'portal', 'fencedframe'])
const resourceAttributes = new Set(['src', 'poster', 'background'])
const policy = [
  "default-src 'none'",
  "img-src file: data:",
  "style-src file: 'unsafe-inline'",
  "font-src file: data:",
  "media-src file: data:",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

function resourcePath(value, source, output, destinations) {
  const reference = value.trim()
  if (!reference) return null
  if (reference.startsWith('#') || /^data:/i.test(reference)) return reference
  try {
    const target = new URL(reference, source)
    const hash = target.hash
    target.hash = ''
    const path = destinations.get(target.href)
    if (!path) return null
    const relative = posix.relative(posix.dirname(output), path)
    return relative.split('/').map(encodeURIComponent).join('/') + hash
  } catch {
    return null
  }
}

function rewriteCssValue(value, resolve, importRule = false) {
  const tree = valueParser(value)
  function update(node) {
    if (node.type === 'function' && node.value.toLowerCase() === 'url') {
      const [path] = node.nodes.filter(child => child.type !== 'space' && child.type !== 'comment')
      const local = path && resolve(path.value)
      node.nodes = [{ type: 'string', quote: '"', value: (local || 'data:,').replace(/["\\\n\r\f]/g, char => '\\' + char.codePointAt(0).toString(16) + ' ') }]
      return false
    }
    if (node.type === 'function' && /^(?:-webkit-)?image-set$/i.test(node.value)) {
      for (const path of node.nodes.filter(child => child.type === 'string')) {
        path.value = resolve(path.value) || 'data:,'
      }
    }
  }
  if (importRule) {
    const first = tree.nodes.find(node => node.type !== 'space' && node.type !== 'comment')
    if (first?.type === 'string') first.value = resolve(first.value) || 'data:,'
  }
  tree.walk(update)
  return tree.toString()
}

function rewriteCss(css, resolve) {
  const sheet = postcss.parse(css)
  sheet.walkDecls((declaration) => {
    declaration.value = rewriteCssValue(declaration.value, resolve)
  })
  sheet.walkAtRules((rule) => {
    if (rule.name.toLowerCase() !== 'charset') {
      rule.params = rewriteCssValue(rule.params, resolve, rule.name.toLowerCase() === 'import')
    }
  })
  return sheet.toResult({ map: false }).css
}

function rewriteHtml(html, source, output, documents, assets) {
  const tree = parse(html)
  const asset = value => resourcePath(value, source, output, assets)
  const document = value => {
    if (/^data:/i.test(value.trim())) return null
    return resourcePath(value, source, output, documents)
  }
  let head
  function visit(parent) {
    for (const child of [...(parent.childNodes || [])]) {
      const tag = child.tagName
      if (removeTags.has(tag)) {
        defaultTreeAdapter.detachNode(child)
        continue
      }
      if (tag === 'head') head = child
      if (tag === 'meta' && child.attrs.some(attr => ['charset', 'http-equiv'].includes(attr.name))) {
        defaultTreeAdapter.detachNode(child)
        continue
      }
      if (tag === 'link') {
        const rel = child.attrs.find(attr => attr.name === 'rel')?.value.toLowerCase().split(/\s+/) || []
        if (!rel.some(value => ['stylesheet', 'icon', 'apple-touch-icon'].includes(value))) {
          defaultTreeAdapter.detachNode(child)
          continue
        }
      }
      if (child.attrs) {
        child.attrs = child.attrs.filter((attr) => {
          const { name, value } = attr
          if (name.startsWith('on') || ['ping', 'action', 'formaction', 'integrity', 'crossorigin'].includes(name)) return false
          if (name === 'href') {
            attr.value = ['a', 'area'].includes(tag) ? document(value) : asset(value)
          } else if (resourceAttributes.has(name)) {
            attr.value = asset(value)
          } else if (name === 'srcset') {
            attr.value = parseSrcset(value).flatMap(({ url, w, h, d }) => {
              const local = asset(url)
              if (!local) return []
              return [[local, w && `${w}w`, h && `${h}h`, d && `${d}x`].filter(Boolean).join(' ')]
            }).join(', ')
          } else if (name === 'style') {
            attr.value = rewriteCssValue(value, asset)
          } else if (child.namespaceURI === 'http://www.w3.org/2000/svg' && value.includes('url(')) {
            attr.value = rewriteCssValue(value, asset)
          }
          return attr.value !== null
        })
      }
      if (tag === 'style') {
        for (const text of child.childNodes) {
          try {
            text.value = rewriteCss(text.value, asset)
          } catch {
            text.value = ''
          }
        }
      }
      visit(child.content || child)
    }
  }
  visit(tree)
  const metadata = parseFragment(`<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}">`)
  for (const node of [...metadata.childNodes].reverse()) {
    defaultTreeAdapter.detachNode(node)
    if (head.childNodes.length) defaultTreeAdapter.insertBefore(head, node, head.childNodes[0])
    else defaultTreeAdapter.appendChild(head, node)
  }
  return serialize(tree)
}

async function createOffline({ staging, entryUrl, snapshots, pages, resources, redirects, assetAliases, offlinePaths, signal }) {
  const output = join(staging, 'offline')
  if (!snapshots.has(entryUrl)) {
    await rm(output, { recursive: true, force: true })
    return null
  }

  const documents = new Map([...snapshots].map(([address, page]) => [address, page.file]))
  for (const { url, finalUrl } of redirects) {
    if (documents.has(finalUrl)) documents.set(url, documents.get(finalUrl))
  }
  const localAssets = new Map()
  for (const asset of resources.values()) {
    const extension = previewExtension(asset.url, asset.contentType)
    if (extension) localAssets.set(asset.url, offlinePaths.asset(asset.url, asset.contentType, extension))
  }
  const assets = new Map(localAssets)
  for (const [source, destination] of assetAliases) {
    if (assets.has(destination) && !assets.has(source)) assets.set(source, assets.get(destination))
  }

  for (const [url, path] of localAssets) {
    signal.throwIfAborted()
    const asset = resources.get(url)
    const source = join(staging, asset.file)
    const local = join(output, path)
    await mkdir(dirname(local), { recursive: true })
    if (extname(path).toLowerCase() === '.css') {
      const resolve = value => resourcePath(value, asset.url, path, assets)
      const css = await readFile(source, 'utf8')
      let rewritten = ''
      try {
        rewritten = rewriteCss(css, resolve)
      } catch {
        // The original stays in the raw archive if the CSS cannot be parsed.
      }
      await writeFile(local, rewritten)
    } else {
      await link(source, local).catch(() => copyFile(source, local))
    }
    asset.offlineFile = 'offline/' + path
  }

  for (const [address, { file, base }] of snapshots) {
    signal.throwIfAborted()
    const local = join(output, file)
    const html = await readFile(local, 'utf8')
    await writeFile(local, rewriteHtml(html, base, file, documents, assets), 'utf8')
    pages.get(address).offlineFile = 'offline/' + file
  }

  return 'offline/' + snapshots.get(entryUrl).file
}

module.exports = { createOffline }
