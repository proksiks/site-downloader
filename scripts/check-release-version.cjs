const { readFileSync } = require('node:fs')
const { version } = require('../package.json')
const tauri = require('../src-tauri/tauri.conf.json')
const cargo = readFileSync(require.resolve('../src-tauri/Cargo.toml'), 'utf8')
const rustVersion = cargo.match(/^version = "([^"]+)"/m)?.[1]
const tag = process.env.GITHUB_REF_NAME

if (tauri.version !== version || rustVersion !== version || tag !== 'v' + version) {
  console.error(`Release tag (${tag}) must match package.json (${version}), tauri.conf.json (${tauri.version}), and Cargo.toml (${rustVersion}).`)
  process.exitCode = 1
}
