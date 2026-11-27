const { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

function githubRepository() {
  const repository = process.env.GITHUB_REPOSITORY || 'proksiks/site-downloader'
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid GitHub repository.')
  return 'https://github.com/' + repository
}

function minisignLines(encoded) {
  return Buffer.from(encoded, 'base64').toString('utf8').split(/\r?\n/)
}

function publicKey() {
  const pubkey = process.env.TAURI_UPDATER_PUBLIC_KEY?.trim() || ''
  const [comment, data = ''] = minisignLines(pubkey)
  const bytes = Buffer.from(data, 'base64')
  if (!comment.startsWith('untrusted comment:') || bytes.length !== 42 || bytes.subarray(0, 2).toString() !== 'Ed') {
    throw new Error('Set the TAURI_UPDATER_PUBLIC_KEY repository variable to the contents of the Tauri .pub file.')
  }
  return { pubkey, id: bytes.subarray(2, 10) }
}

function updaterConfig() {
  const { pubkey } = publicKey()
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY?.trim()) {
    throw new Error('Set the TAURI_SIGNING_PRIVATE_KEY repository secret.')
  }
  return {
    bundle: { createUpdaterArtifacts: true },
    plugins: {
      updater: {
        pubkey,
        endpoints: [githubRepository() + '/releases/latest/download/latest.json'],
        requireSignedVersion: true,
      },
    },
  }
}

const installers = [
  { build: 'windows-x64', extension: '.exe', platform: 'windows-x86_64-nsis' },
  { build: 'linux-x64', extension: '.deb', platform: 'linux-x86_64-deb' },
  { build: 'linux-x64', extension: '.AppImage', platform: 'linux-x86_64-appimage' },
  { build: 'macos-arm64', extension: '_aarch64.dmg' },
  { build: 'macos-x64', extension: '_x64.dmg' },
  { build: 'macos-arm64', extension: '.app.tar.gz', platform: 'darwin-aarch64-app' },
  { build: 'macos-x64', extension: '.app.tar.gz', platform: 'darwin-x86_64-app' },
]

function filesIn(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isFile()) files.push({ path, name: entry.name })
    if (entry.isDirectory()) files.push(...filesIn(path))
  }
  return files
}

function stageRelease(input, output, tag) {
  const { version } = require('../package.json')
  if (tag !== 'v' + version) throw new Error('Release tag must match the application version.')
  const { id } = publicKey()
  const baseUrl = githubRepository() + '/releases/download/' + encodeURIComponent(tag) + '/'
  const platforms = {}
  mkdirSync(output, { recursive: true })
  for (const { build, extension, platform } of installers) {
    const matching = filesIn(join(input, 'site-downloader-' + build)).filter(file => file.name.endsWith(extension))
    if (matching.length !== 1) throw new Error('Expected exactly one ' + extension + ' artifact for ' + build + '.')
    const [asset] = matching
    // Use names GitHub can store unchanged, and distinguish the two macOS updater archives.
    const name = extension === '.app.tar.gz' ? 'Site.Downloader_' + version + '_' + build + extension
      : asset.name.replace(/[^\w.-]/g, '.')
    if (platform) {
      const signature = readFileSync(asset.path + '.sig', 'utf8').trim()
      const [, data, trustedComment] = minisignLines(signature)
      const signed = Buffer.from(data || '', 'base64')
      if (signed.length !== 74 || !signed.subarray(2, 10).equals(id)) {
        throw new Error('Updater signature for ' + asset.name + ' does not match the configured public key.')
      }
      if (!trustedComment?.split('\t').includes('version:' + version)) {
        throw new Error('Updater signature for ' + asset.name + ' must be bound to version ' + version + '.')
      }
      platforms[platform] = { url: baseUrl + encodeURIComponent(name), signature }
      copyFileSync(asset.path + '.sig', join(output, name + '.sig'))
    }
    copyFileSync(asset.path, join(output, name))
  }
  writeFileSync(join(output, 'latest.json'), JSON.stringify({ version, pub_date: new Date().toISOString(), platforms }, null, 2) + '\n')
}

try {
  const [command, input, output, tag] = process.argv.slice(2)
  if (command === 'config') process.stdout.write(JSON.stringify(updaterConfig()))
  else if (command === 'stage' && input && output && tag) stageRelease(input, output, tag)
  else throw new Error('Usage: updater-release.cjs config | stage INPUT OUTPUT TAG')
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
