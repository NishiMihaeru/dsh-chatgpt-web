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
})

test('bundle patch mounts one runtime row', () => {
  assert.match(patch, /id:\s*llm-chatgpt-web/)
  assert.match(patch, /name:\s*dsh-chatgpt-web/)
  assert.doesNotMatch(patch, /0\.0\.0\.0/)
})
