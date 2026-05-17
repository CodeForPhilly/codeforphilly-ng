/**
 * Generate a transient self-signed RSA cert + key pair for SAML tests.
 *
 * Shells out to `openssl` because Node's built-in crypto can produce a key
 * pair but not a self-signed X.509 cert without third-party libs. openssl is
 * universally available on the dev + CI machines we care about; tests that
 * import this helper will fail loudly if it isn't.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface SamlTestKeyPair {
  readonly privateKeyPem: string;
  readonly certificatePem: string;
}

let cached: SamlTestKeyPair | undefined;

/**
 * Returns a memoised key pair — generating one takes ~150ms and we want every
 * test in the file to share it.
 */
export async function getSamlTestKeyPair(): Promise<SamlTestKeyPair> {
  if (cached) return cached;
  const dir = await mkdtemp(join(tmpdir(), 'cfp-saml-cert-'));
  try {
    const keyPath = join(dir, 'key.pem');
    const certPath = join(dir, 'cert.pem');
    await execFileAsync('openssl', [
      'req',
      '-x509',
      '-newkey', 'rsa:2048',
      '-keyout', keyPath,
      '-out', certPath,
      '-sha256',
      '-days', '7',
      '-nodes',
      '-subj', '/CN=cfp-test-saml-idp',
    ]);
    const [privateKeyPem, certificatePem] = await Promise.all([
      readFile(keyPath, 'utf8'),
      readFile(certPath, 'utf8'),
    ]);
    cached = { privateKeyPem, certificatePem };
    return cached;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
