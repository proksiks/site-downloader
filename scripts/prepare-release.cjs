const { copyFile, mkdir, chmod } = require('node:fs/promises')
const { dirname, join, resolve } = require('node:path')

async function prepareRelease() {
  const destination = resolve(__dirname, '../dist-runtime')
  const windows = process.platform === 'win32'
  const runtime = join(destination, windows ? 'node.exe' : 'node')
  const installation = dirname(process.execPath)
  await mkdir(destination, { recursive: true })
  await copyFile(process.execPath, runtime)
  if (!windows) await chmod(runtime, 0o755)

  for (const directory of [installation, dirname(installation)]) {
    try {
      await copyFile(join(directory, 'LICENSE'), join(destination, 'LICENSE-node.txt'))
      console.log(`Prepared Node.js ${process.versions.node} for ${process.platform}/${process.arch}.`)
      return
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  throw new Error('Node.js LICENSE was not found. Build with the official Node.js distribution.')
}

prepareRelease().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
