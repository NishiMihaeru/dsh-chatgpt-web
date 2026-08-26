import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string
  version: string
  type: string
  main: string
  types: string
  files: string[]
  dsh: unknown
}
const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8')) as {
  manifest_version: number
  key: string
  permissions: string[]
  host_permissions: string[]
  content_scripts: Array<{ matches: string[]; js: string[] }>
}

test('package is an installable DSH bundle', () => {
  assert.equal(pkg.name, 'dsh-chatgpt-web')
  assert.equal(pkg.version, '0.1.0')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, './lib/index.js')
  assert.equal(pkg.types, './lib/index.d.ts')
  assert.deepEqual(pkg.dsh, { bundle: { patch: './cordis.patch.yml' } })
  assert.ok(pkg.files.includes('lib'))
  assert.ok(pkg.files.includes('extension'))
  assert.ok(pkg.files.includes('cordis.patch.yml'))
  assert.equal(pkg.files.some(file => file.includes('.github')), false)
})

test('bundle patch mounts one runtime row and never exposes a public bind', () => {
  assert.match(patch, /id:\s*llm-chatgpt-web/)
  assert.match(patch, /name:\s*dsh-chatgpt-web/)
  assert.doesNotMatch(patch, /0\.0\.0\.0/)
})

test('extension permissions stay scoped to ChatGPT and loopback', () => {
  assert.equal(manifest.manifest_version, 3)
  assert.ok(manifest.key.length > 100)
  assert.deepEqual(manifest.permissions.sort(), ['storage', 'tabs'])
  assert.deepEqual(manifest.host_permissions.sort(), ['http://127.0.0.1/*', 'https://chatgpt.com/*'])
  assert.deepEqual(manifest.content_scripts[0]?.matches, ['https://chatgpt.com/*'])
  assert.deepEqual(manifest.content_scripts[0]?.js, ['chatgpt-page-adapter.js', 'content-script.js'])
})

test('README documents install, limitations, privacy, and local-only verification', () => {
  assert.match(readme, /dsh plugin --profile web add \./)
  assert.match(readme, /dsh plugin --profile web add dsh-chatgpt-web/)
  assert.match(readme, /chatgpt-web\/auto/)
  assert.match(readme, /chrome:\/\/extensions/)
  assert.match(readme, /Load unpacked/i)
  assert.match(readme, /No OpenAI API key/i)
  assert.match(readme, /text-only/i)
  assert.match(readme, /one dedicated Chrome worker tab/i)
  assert.match(readme, /tool schemas.*not callable/is)
  assert.match(readme, /never enumerates the ChatGPT sidebar/i)
  assert.match(readme, /npm run check/)
  assert.match(readme, /npm test/)
  assert.match(readme, /no GitHub Actions or CI workflow/i)
})
