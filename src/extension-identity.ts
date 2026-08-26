import { createHash } from 'node:crypto'

export const EXTENSION_PUBLIC_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAy89iuhKXJ1oxESqZ2BhkuWnYx8VEHBbt0HrXy6u/NVlmiOyqcOz+7EbMRPeB7BeXp3lhHpdRaSUHSD+zWtDSDu8UneSEpyNXIXVzQyxT6trCvz3U6JkCw3ij4bbVVSuodfEdGdtTFQxpm50ZinynWTr6hDyK+f4oOzUYZP2CujhoVuZP4nxVGjfs8qZY/x8QYqiO/eLpmHLTJ+5ygCEsHJeG1mEjVJqOSMo/F/3kzzOwq1j6nd+tQ6FDIGsPqBm667EiKcf2x6NAEy5mJLxtcPQMJF3cUGxcoSdlMPW8x+0IYQVQRwZcAbysBymCzfvKbQhzvfm6lAbC4Ayo9Zl50wIDAQAB'

const HEX_TO_EXTENSION = 'abcdefghijklmnop'

export function extensionIdFromManifestKey(base64DerPublicKey: string): string {
  const compact = base64DerPublicKey.replace(/\s+/g, '')
  if (compact.length === 0) throw new Error('extension public key must not be empty')
  const der = Buffer.from(compact, 'base64')
  if (der.length === 0) throw new Error('extension public key is not valid base64 DER')
  const digest = createHash('sha256').update(der).digest().subarray(0, 16)
  let id = ''
  for (const byte of digest) {
    id += HEX_TO_EXTENSION[(byte >> 4) & 0xf]
    id += HEX_TO_EXTENSION[byte & 0xf]
  }
  return id
}

export function extensionOriginFromManifestKey(base64DerPublicKey: string): string {
  return `chrome-extension://${extensionIdFromManifestKey(base64DerPublicKey)}`
}

export const EXTENSION_ID = extensionIdFromManifestKey(EXTENSION_PUBLIC_KEY)
export const EXTENSION_ORIGIN = extensionOriginFromManifestKey(EXTENSION_PUBLIC_KEY)
