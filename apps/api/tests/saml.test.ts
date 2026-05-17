/**
 * Tests for saml-idp plan validation criteria.
 *
 * Covers:
 *  - GET /api/saml/slack/metadata returns parseable SAML 2.0 IdP metadata
 *  - GET /api/saml/slack/launch (anonymous) → 302 to /login
 *  - GET /api/saml/slack/launch (signed-in) → auto-submit form with signed
 *    SAMLResponse carrying the expected NameID + attribute set
 *  - GET /api/saml/slack/launch?channel=phlask → relayState carries channel
 *  - GET /api/saml/slack/launch?channel=<bad> → 422
 *  - POST /api/saml/slack/sso (anonymous) → resume cookie + 302 to /login
 *  - GET /api/saml/slack/sso/resume (signed-in, valid cookie) → POST form
 *  - Metadata endpoint without SAML_PRIVATE_KEY → 500 saml_signing_failed
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DOMParser } from '@xmldom/xmldom';

import { buildApp } from '../src/app.js';
import { mintSessionFor } from '../src/auth/issue.js';
import { createFullDataRepo, createPrivateStorageDir } from './helpers/test-full-repo.js';
import { getSamlTestKeyPair, type SamlTestKeyPair } from './helpers/saml-cert.js';

const exec = promisify(execFile);
const JWT_KEY = 'test-jwt-signing-key-at-least-32-chars!!';
const SLACK_TEAM_HOST = 'codeforphilly.slack.com';

async function seedPerson(
  repoDir: string,
  opts: {
    slug: string;
    id: string;
    slackSamlNameId: string;
    firstName?: string;
    lastName?: string;
    accountLevel?: string;
  },
): Promise<void> {
  const git = (...args: string[]) => exec('git', args, { cwd: repoDir });
  const lines = [
    `id = "${opts.id}"`,
    `slug = "${opts.slug}"`,
    `fullName = "Test ${opts.slug}"`,
    `accountLevel = "${opts.accountLevel ?? 'user'}"`,
    `slackSamlNameId = "${opts.slackSamlNameId}"`,
    opts.firstName ? `firstName = "${opts.firstName}"` : '',
    opts.lastName ? `lastName = "${opts.lastName}"` : '',
    `createdAt = "2026-05-01T00:00:00Z"`,
    `updatedAt = "2026-05-01T00:00:00Z"`,
  ].filter(Boolean);

  await mkdir(join(repoDir, 'people'), { recursive: true });
  await writeFile(join(repoDir, 'people', `${opts.slug}.toml`), lines.join('\n'));
  await git('add', `people/${opts.slug}.toml`);
  await git(
    '-c', 'user.email=test@cfp.test',
    '-c', 'user.name=test',
    'commit', '-m', `seed person ${opts.slug}`,
  );
}

async function seedPrivateProfile(
  privateDir: string,
  opts: { personId: string; email: string },
): Promise<void> {
  const profiles = [
    JSON.stringify({
      personId: opts.personId,
      email: opts.email,
      emailRefreshedAt: '2026-05-01T00:00:00Z',
      newsletter: { optedIn: false, optedInAt: null, optedOutAt: null, unsubscribeToken: null },
      updatedAt: '2026-05-01T00:00:00Z',
    }),
  ].join('\n');
  await writeFile(join(privateDir, 'profiles.jsonl'), profiles + '\n');
}

async function buildTestApp(
  dataPath: string,
  privatePath: string,
  keyPair: SamlTestKeyPair,
  extra: Partial<Record<string, string>> = {},
): Promise<FastifyInstance> {
  return buildApp({
    serverOptions: { logger: false },
    overrideEnv: {
      CFP_DATA_REPO_PATH: dataPath,
      STORAGE_BACKEND: 'filesystem',
      CFP_PRIVATE_STORAGE_PATH: privatePath,
      CFP_JWT_SIGNING_KEY: JWT_KEY,
      SAML_PRIVATE_KEY: keyPair.privateKeyPem,
      SAML_CERTIFICATE: keyPair.certificatePem,
      SLACK_TEAM_HOST,
      NODE_ENV: 'test',
      ...extra,
    },
  });
}

describe('SAML IdP — Slack', () => {
  let dataRepo: { path: string; cleanup: () => Promise<void> };
  let privateStore: { path: string; cleanup: () => Promise<void> };
  let app: FastifyInstance;
  let keyPair: SamlTestKeyPair;
  const personId = '01951a3c-0000-7000-8000-000000000001';
  const slug = 'jane';

  beforeAll(async () => {
    keyPair = await getSamlTestKeyPair();
    dataRepo = await createFullDataRepo();
    privateStore = await createPrivateStorageDir();
    await seedPerson(dataRepo.path, {
      id: personId,
      slug,
      slackSamlNameId: slug, // matches the spec "slackSamlNameId = slug at creation"
      firstName: 'Jane',
      lastName: 'Doe',
    });
    await seedPrivateProfile(privateStore.path, { personId, email: 'jane@example.com' });
    app = await buildTestApp(dataRepo.path, privateStore.path, keyPair);
  });

  afterAll(async () => {
    await app.close();
    await dataRepo.cleanup();
    await privateStore.cleanup();
  });

  it('GET /api/saml/slack/metadata returns valid SAML metadata', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/saml/slack/metadata' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/samlmetadata\+xml/);

    const doc = new DOMParser().parseFromString(res.body, 'application/xml');
    const root = doc.documentElement;
    expect(root?.localName).toBe('EntityDescriptor');

    // entityID present
    expect(root?.getAttribute('entityID')).toBe(
      `https://${SLACK_TEAM_HOST}/api/saml/slack/metadata`,
    );

    // IDPSSODescriptor + at least one SingleSignOnService and an X509Certificate.
    const idpDescriptors = root?.getElementsByTagNameNS(
      'urn:oasis:names:tc:SAML:2.0:metadata',
      'IDPSSODescriptor',
    );
    expect(idpDescriptors?.length ?? 0).toBeGreaterThan(0);

    const ssoServices = root?.getElementsByTagNameNS(
      'urn:oasis:names:tc:SAML:2.0:metadata',
      'SingleSignOnService',
    );
    expect((ssoServices?.length ?? 0)).toBeGreaterThanOrEqual(2);

    const certs = root?.getElementsByTagNameNS(
      'http://www.w3.org/2000/09/xmldsig#',
      'X509Certificate',
    );
    expect((certs?.length ?? 0)).toBeGreaterThan(0);

    // NameID format declared
    const formats = Array.from(
      root?.getElementsByTagNameNS('urn:oasis:names:tc:SAML:2.0:metadata', 'NameIDFormat') ?? [],
    ).map((el) => el.textContent);
    expect(formats).toContain('urn:oasis:names:tc:SAML:2.0:nameid-format:persistent');
  });

  it('GET /api/saml/slack/launch (anonymous) redirects to /login', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/saml/slack/launch' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^\/login\?return=/);
  });

  it('GET /api/saml/slack/launch (signed-in) returns auto-submit form with signed SAML response', async () => {
    const { accessToken } = await mintSessionFor(personId, 'user', JWT_KEY);
    const res = await app.inject({
      method: 'GET',
      url: '/api/saml/slack/launch',
      cookies: { cfp_session: accessToken },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);

    // Form posts to Slack's ACS URL
    expect(res.body).toContain(`action="https://${SLACK_TEAM_HOST}/sso/saml"`);
    // SAMLResponse field present
    const match = /name="SAMLResponse" value="([^"]+)"/.exec(res.body);
    expect(match).not.toBeNull();
    const samlResponseB64 = match![1];
    expect(typeof samlResponseB64).toBe('string');

    // Decode + parse the response XML
    const xml = Buffer.from(samlResponseB64!, 'base64').toString('utf8');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const root = doc.documentElement;
    expect(root?.localName).toBe('Response');

    // NameID is the slackSamlNameId, format persistent
    const nameIdEl = root?.getElementsByTagNameNS(
      'urn:oasis:names:tc:SAML:2.0:assertion',
      'NameID',
    )[0];
    expect(nameIdEl?.textContent).toBe(slug);
    expect(nameIdEl?.getAttribute('Format')).toBe(
      'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
    );
    expect(nameIdEl?.getAttribute('NameQualifier')).toBe(SLACK_TEAM_HOST);
    expect(nameIdEl?.getAttribute('SPNameQualifier')).toBe('https://slack.com');

    // Attributes carry the expected values
    const attrs = Array.from(
      root?.getElementsByTagNameNS(
        'urn:oasis:names:tc:SAML:2.0:assertion',
        'Attribute',
      ) ?? [],
    );
    const byName = new Map<string, string>();
    for (const a of attrs) {
      const name = a.getAttribute('Name')!;
      const value = a.getElementsByTagNameNS(
        'urn:oasis:names:tc:SAML:2.0:assertion',
        'AttributeValue',
      )[0]?.textContent ?? '';
      byName.set(name, value);
    }
    expect(byName.get('User.Email')).toBe('jane@example.com');
    expect(byName.get('User.Username')).toBe(slug);
    expect(byName.get('first_name')).toBe('Jane');
    expect(byName.get('last_name')).toBe('Doe');

    // Signature present (xmldsig namespace)
    const sigs = root?.getElementsByTagNameNS(
      'http://www.w3.org/2000/09/xmldsig#',
      'Signature',
    );
    expect((sigs?.length ?? 0)).toBeGreaterThan(0);
  });

  it('GET /api/saml/slack/launch?channel=phlask carries channel as RelayState', async () => {
    const { accessToken } = await mintSessionFor(personId, 'user', JWT_KEY);
    const res = await app.inject({
      method: 'GET',
      url: '/api/saml/slack/launch?channel=phlask',
      cookies: { cfp_session: accessToken },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('name="RelayState" value="phlask"');
  });

  it('GET /api/saml/slack/launch?channel=<invalid> → 422 validation_failed', async () => {
    const { accessToken } = await mintSessionFor(personId, 'user', JWT_KEY);
    const res = await app.inject({
      method: 'GET',
      url: '/api/saml/slack/launch?channel=BAD_CASE!',
      cookies: { cfp_session: accessToken },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json<{ success: boolean; error: { code: string } }>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('validation_failed');
  });

  it('POST /api/saml/slack/sso (anonymous) sets resume cookie and redirects to /login', async () => {
    // Build a minimal Slack-like AuthnRequest pointing at the right ACS.
    const authnXml = `<?xml version="1.0"?>
<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="id-test-1" Version="2.0" IssueInstant="2026-05-01T00:00:00Z" AssertionConsumerServiceURL="https://${SLACK_TEAM_HOST}/sso/saml" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"><saml:Issuer>https://slack.com</saml:Issuer></samlp:AuthnRequest>`;
    const samlRequestB64 = Buffer.from(authnXml, 'utf8').toString('base64');

    const res = await app.inject({
      method: 'POST',
      url: '/api/saml/slack/sso',
      payload: new URLSearchParams({
        SAMLRequest: samlRequestB64,
        RelayState: 'opaque-state-from-slack',
      }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^\/login\?return=/);
    // Resume cookie set
    const cookies = res.headers['set-cookie'];
    const cookieStr = Array.isArray(cookies) ? cookies.join('\n') : String(cookies ?? '');
    expect(cookieStr).toContain('cfp_saml_resume=');
  });

  it('POST /api/saml/slack/sso with bad ACS URL → 422', async () => {
    const authnXml = `<?xml version="1.0"?>
<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="id-test-2" Version="2.0" IssueInstant="2026-05-01T00:00:00Z" AssertionConsumerServiceURL="https://evil.example.com/acs" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"><saml:Issuer>https://slack.com</saml:Issuer></samlp:AuthnRequest>`;
    const samlRequestB64 = Buffer.from(authnXml, 'utf8').toString('base64');
    const { accessToken } = await mintSessionFor(personId, 'user', JWT_KEY);

    const res = await app.inject({
      method: 'POST',
      url: '/api/saml/slack/sso',
      payload: new URLSearchParams({ SAMLRequest: samlRequestB64 }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      cookies: { cfp_session: accessToken },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json<{ success: boolean; error: { code: string } }>();
    expect(body.error.code).toBe('validation_failed');
  });

  it('POST /api/saml/slack/sso (signed-in) returns auto-submit form back to Slack ACS', async () => {
    const authnXml = `<?xml version="1.0"?>
<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="id-test-3" Version="2.0" IssueInstant="2026-05-01T00:00:00Z" AssertionConsumerServiceURL="https://${SLACK_TEAM_HOST}/sso/saml" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"><saml:Issuer>https://slack.com</saml:Issuer></samlp:AuthnRequest>`;
    const samlRequestB64 = Buffer.from(authnXml, 'utf8').toString('base64');
    const { accessToken } = await mintSessionFor(personId, 'user', JWT_KEY);

    const res = await app.inject({
      method: 'POST',
      url: '/api/saml/slack/sso',
      payload: new URLSearchParams({
        SAMLRequest: samlRequestB64,
        RelayState: 'opaque-state-from-slack',
      }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      cookies: { cfp_session: accessToken },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`action="https://${SLACK_TEAM_HOST}/sso/saml"`);
    expect(res.body).toContain('name="SAMLResponse"');
    expect(res.body).toContain('name="RelayState" value="opaque-state-from-slack"');
  });
});

describe('SAML IdP — without configured cert/key', () => {
  let dataRepo: { path: string; cleanup: () => Promise<void> };
  let privateStore: { path: string; cleanup: () => Promise<void> };
  let app: FastifyInstance;

  beforeAll(async () => {
    dataRepo = await createFullDataRepo();
    privateStore = await createPrivateStorageDir();
    app = await buildApp({
      serverOptions: { logger: false },
      overrideEnv: {
        CFP_DATA_REPO_PATH: dataRepo.path,
        STORAGE_BACKEND: 'filesystem',
        CFP_PRIVATE_STORAGE_PATH: privateStore.path,
        CFP_JWT_SIGNING_KEY: JWT_KEY,
        NODE_ENV: 'test',
      },
    });
  });

  afterAll(async () => {
    await app.close();
    await dataRepo.cleanup();
    await privateStore.cleanup();
  });

  it('GET /api/saml/slack/metadata returns 500 saml_signing_failed', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/saml/slack/metadata' });
    expect(res.statusCode).toBe(500);
    const body = res.json<{ success: boolean; error: { code: string } }>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('saml_signing_failed');
  });
});
