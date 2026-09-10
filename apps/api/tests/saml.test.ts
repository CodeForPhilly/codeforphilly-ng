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
 *  - Assertion carries an AuthnStatement (fixed ClassRef, AuthnInstant <=
 *    IssueInstant, fresh SessionIndex) — specs/api/saml.md#authentication-statement
 *  - POST /api/saml/slack/sso (anonymous) → resume cookie + 302 to /login
 *  - GET /api/saml/slack/sso (HTTP-Redirect binding, DEFLATEd SAMLRequest)
 *    behaves exactly as POST for signed-in / signed-out / bad payload, and
 *    the anonymous path resumes through /sso/resume
 *  - GET /api/saml/slack/sso/resume (signed-in, valid cookie) → POST form
 *  - Metadata endpoint without SAML_PRIVATE_KEY → 500 saml_signing_failed
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { DOMParser } from '@xmldom/xmldom';
import * as samlify from 'samlify';

import { buildApp } from '../src/app.js';
import { mintSessionFor } from '../src/auth/issue.js';
import { createFullDataRepo, createPrivateStorageDir } from './helpers/test-full-repo.js';
import { seedRawToml } from './helpers/seed-fixtures.js';
import { getSamlTestKeyPair, type SamlTestKeyPair } from './helpers/saml-cert.js';

const JWT_KEY = 'test-jwt-signing-key-at-least-32-chars!!';
const SLACK_TEAM_HOST = 'codeforphilly.slack.com';
/** Default SAML_ENTITY_ID per specs/api/saml.md#idp-identity-and-hosts. */
const DEFAULT_ENTITY_ID = 'https://codeforphilly.org/api/saml/slack/metadata';
/** Default CFP_SITE_HOST — the SSO endpoint Locations are built on it. */
const DEFAULT_SITE_HOST = 'codeforphilly.org';

const MD_NS = 'urn:oasis:names:tc:SAML:2.0:metadata';
const ASSERTION_NS = 'urn:oasis:names:tc:SAML:2.0:assertion';

function ssoLocations(metadataXml: string): { entityId: string | null; locations: string[] } {
  const doc = new DOMParser().parseFromString(metadataXml, 'application/xml');
  const root = doc.documentElement;
  const locations = Array.from(root?.getElementsByTagNameNS(MD_NS, 'SingleSignOnService') ?? [])
    .map((el) => el.getAttribute('Location'))
    .filter((v): v is string => typeof v === 'string');
  return { entityId: root?.getAttribute('entityID') ?? null, locations };
}

/** Every `<saml:Issuer>` text in a decoded SAMLResponse (Response + Assertion). */
function issuers(responseXml: string): string[] {
  const doc = new DOMParser().parseFromString(responseXml, 'application/xml');
  return Array.from(doc.documentElement?.getElementsByTagNameNS(ASSERTION_NS, 'Issuer') ?? []).map(
    (el) => el.textContent ?? '',
  );
}

function decodeSamlResponse(html: string): string {
  const match = /name="SAMLResponse" value="([^"]+)"/.exec(html);
  expect(match).not.toBeNull();
  return Buffer.from(match![1]!, 'base64').toString('utf8');
}

/** Fixed AuthnContextClassRef per specs/api/saml.md#authentication-statement. */
const AUTHN_CONTEXT_CLASS_REF = 'urn:oasis:names:tc:SAML:2.0:ac:classes:Password';

/** A minimal Slack-shaped AuthnRequest targeting the configured ACS. */
function slackAuthnRequestXml(id: string, acsHost: string = SLACK_TEAM_HOST): string {
  return `<?xml version="1.0"?>
<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="2026-05-01T00:00:00Z" AssertionConsumerServiceURL="https://${acsHost}/sso/saml" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"><saml:Issuer>https://slack.com</saml:Issuer></samlp:AuthnRequest>`;
}

/**
 * HTTP-Redirect binding encoding (saml-bindings §3.4.4.1): raw DEFLATE →
 * base64 → URL-encode. Returns the ready-to-append query string.
 */
function redirectBindingQuery(xml: string, relayState?: string): string {
  const deflated = deflateRawSync(Buffer.from(xml, 'utf8')).toString('base64');
  const params = new URLSearchParams({ SAMLRequest: deflated });
  if (relayState !== undefined) params.set('RelayState', relayState);
  return params.toString();
}

function resumeCookieValue(res: { headers: Record<string, unknown> }): string {
  const cookies = res.headers['set-cookie'];
  const list = Array.isArray(cookies) ? cookies : [String(cookies ?? '')];
  const hit = list.find((c) => c.startsWith('cfp_saml_resume='));
  expect(hit).toBeDefined();
  return hit!.split(';')[0]!.slice('cfp_saml_resume='.length);
}

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

  await seedRawToml(repoDir, `people/${opts.slug}.toml`, lines.join('\n'), `seed person ${opts.slug}`);
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

    // entityID is the stable SAML_ENTITY_ID default — NOT built on
    // SLACK_TEAM_HOST (Slack's host) and NOT on the serving host.
    expect(root?.getAttribute('entityID')).toBe(DEFAULT_ENTITY_ID);

    // Both SSO bindings point at our own site host.
    const { locations } = ssoLocations(res.body);
    expect(locations).toHaveLength(2);
    for (const loc of locations) {
      expect(loc).toBe(`https://${DEFAULT_SITE_HOST}/api/saml/slack/sso`);
    }
    expect(res.body).not.toContain(`https://${SLACK_TEAM_HOST}/api/saml`);

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

    // Issuer on both the Response and the Assertion is the entity ID — the
    // same value the metadata advertises as entityID.
    expect(issuers(xml)).toEqual([DEFAULT_ENTITY_ID, DEFAULT_ENTITY_ID]);

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

  it('assertion carries an AuthnStatement with the fixed ClassRef and a sane AuthnInstant', async () => {
    const { accessToken } = await mintSessionFor(personId, 'user', JWT_KEY);
    const res = await app.inject({
      method: 'GET',
      url: '/api/saml/slack/launch',
      cookies: { cfp_session: accessToken },
    });
    expect(res.statusCode).toBe(200);

    const xml = decodeSamlResponse(res.body);
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const root = doc.documentElement!;
    const assertion = root.getElementsByTagNameNS(ASSERTION_NS, 'Assertion')[0]!;

    // Exactly one AuthnStatement, placed after Conditions and before
    // AttributeStatement (schema order, saml-core §2.3.3).
    const authnStatements = assertion.getElementsByTagNameNS(ASSERTION_NS, 'AuthnStatement');
    expect(authnStatements.length).toBe(1);
    const authn = authnStatements[0]!;
    const childNames = Array.from(assertion.childNodes)
      .filter((n) => n.nodeType === 1)
      .map((n) => (n as Element).localName);
    expect(childNames.indexOf('AuthnStatement')).toBeGreaterThan(childNames.indexOf('Conditions'));
    expect(childNames.indexOf('AuthnStatement')).toBeLessThan(
      childNames.indexOf('AttributeStatement'),
    );

    // Fixed ClassRef — not echoed from any RequestedAuthnContext.
    const classRef = authn.getElementsByTagNameNS(ASSERTION_NS, 'AuthnContextClassRef')[0];
    expect(classRef?.textContent).toBe(AUTHN_CONTEXT_CLASS_REF);

    // AuthnInstant parses as an ISO date and is <= the assertion's IssueInstant.
    const authnInstant = authn.getAttribute('AuthnInstant');
    const issueInstant = assertion.getAttribute('IssueInstant');
    expect(authnInstant).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(Number.isNaN(Date.parse(authnInstant!))).toBe(false);
    expect(Date.parse(authnInstant!)).toBeLessThanOrEqual(Date.parse(issueInstant!));

    // SessionIndex is present, opaque, and not the assertion ID.
    const sessionIndex = authn.getAttribute('SessionIndex');
    expect(sessionIndex).toMatch(/^_[0-9a-f]+$/);
    expect(sessionIndex).not.toBe(assertion.getAttribute('ID'));

    // SessionNotOnOrAfter is omitted by design.
    expect(authn.hasAttribute('SessionNotOnOrAfter')).toBe(false);

    // The statement sits inside the signed subtree: the enveloped Signature
    // is a child of the Assertion and its Reference points at the Assertion ID.
    const sig = assertion.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature')[0];
    expect(sig?.parentNode).toBe(assertion);
    const ref = sig?.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Reference')[0];
    expect(ref?.getAttribute('URI')).toBe(`#${assertion.getAttribute('ID')}`);
  });

  it('assertion signature verifies against the metadata cert and covers the AuthnStatement', async () => {
    const meta = await app.inject({ method: 'GET', url: '/api/saml/slack/metadata' });
    expect(meta.statusCode).toBe(200);
    const idpMetadata = samlify.IdPMetadata(meta.body);

    const { accessToken } = await mintSessionFor(personId, 'user', JWT_KEY);
    const res = await app.inject({
      method: 'GET',
      url: '/api/saml/slack/launch',
      cookies: { cfp_session: accessToken },
    });
    expect(res.statusCode).toBe(200);
    const xml = decodeSamlResponse(res.body);

    // Signing happens after templating, so the substituted AuthnStatement is
    // inside the signed subtree: the untouched Response verifies...
    const [verified, signedAssertion] = samlify.SamlLib.verifySignature(xml, {
      metadata: idpMetadata,
    });
    expect(verified).toBe(true);
    expect(signedAssertion).toContain('<saml:AuthnStatement');
    expect(signedAssertion).toContain(AUTHN_CONTEXT_CLASS_REF);

    // ...and flipping the ClassRef after the fact breaks the signature.
    const tampered = xml.replace(
      AUTHN_CONTEXT_CLASS_REF,
      'urn:oasis:names:tc:SAML:2.0:ac:classes:unspecified',
    );
    expect(tampered).not.toBe(xml);
    const [tamperedVerified] = samlify.SamlLib.verifySignature(tampered, { metadata: idpMetadata });
    expect(tamperedVerified).toBe(false);
  });

  it('GET /api/saml/slack/sso (redirect binding, anonymous) sets resume cookie and redirects to /login', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/saml/slack/sso?${redirectBindingQuery(slackAuthnRequestXml('id-redirect-1'), 'opaque-redirect-state')}`,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^\/login\?return=/);
    expect(resumeCookieValue(res)).not.toBe('');
  });

  it('GET /api/saml/slack/sso (redirect binding, anonymous) → /sso/resume completes with InResponseTo + RelayState', async () => {
    const start = await app.inject({
      method: 'GET',
      url: `/api/saml/slack/sso?${redirectBindingQuery(slackAuthnRequestXml('id-redirect-2'), 'opaque-redirect-state')}`,
    });
    expect(start.statusCode).toBe(302);
    const resumeCookie = resumeCookieValue(start);

    const { accessToken } = await mintSessionFor(personId, 'user', JWT_KEY);
    const res = await app.inject({
      method: 'GET',
      url: '/api/saml/slack/sso/resume',
      cookies: { cfp_session: accessToken, cfp_saml_resume: resumeCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`action="https://${SLACK_TEAM_HOST}/sso/saml"`);
    expect(res.body).toContain('name="RelayState" value="opaque-redirect-state"');

    const xml = decodeSamlResponse(res.body);
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    expect(doc.documentElement?.getAttribute('InResponseTo')).toBe('id-redirect-2');
    expect(
      doc.documentElement?.getElementsByTagNameNS(ASSERTION_NS, 'AuthnStatement').length,
    ).toBe(1);
  });

  it('GET /api/saml/slack/sso (redirect binding, signed-in) returns auto-submit form back to Slack ACS', async () => {
    const { accessToken } = await mintSessionFor(personId, 'user', JWT_KEY);
    const res = await app.inject({
      method: 'GET',
      url: `/api/saml/slack/sso?${redirectBindingQuery(slackAuthnRequestXml('id-redirect-3'), 'opaque-redirect-state')}`,
      cookies: { cfp_session: accessToken },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain(`action="https://${SLACK_TEAM_HOST}/sso/saml"`);
    expect(res.body).toContain('name="RelayState" value="opaque-redirect-state"');

    const xml = decodeSamlResponse(res.body);
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const root = doc.documentElement!;
    expect(root.localName).toBe('Response');
    expect(root.getAttribute('InResponseTo')).toBe('id-redirect-3');
    expect(root.getElementsByTagNameNS(ASSERTION_NS, 'NameID')[0]?.textContent).toBe(slug);
  });

  it('GET /api/saml/slack/sso (redirect binding) with bad ACS URL → 422', async () => {
    const { accessToken } = await mintSessionFor(personId, 'user', JWT_KEY);
    const res = await app.inject({
      method: 'GET',
      url: `/api/saml/slack/sso?${redirectBindingQuery(slackAuthnRequestXml('id-redirect-4', 'evil.example.com'))}`,
      cookies: { cfp_session: accessToken },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('validation_failed');
  });

  it('GET /api/saml/slack/sso with a non-DEFLATEd (POST-style) SAMLRequest → 422', async () => {
    // Plain base64 (no DEFLATE) is the POST binding's wire form; on the
    // Redirect binding it must fail to inflate rather than be accepted.
    const plainB64 = Buffer.from(slackAuthnRequestXml('id-redirect-5'), 'utf8').toString('base64');
    const res = await app.inject({
      method: 'GET',
      url: `/api/saml/slack/sso?${new URLSearchParams({ SAMLRequest: plainB64 }).toString()}`,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('validation_failed');
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

describe('SAML IdP — entity ID vs. site host', () => {
  let dataRepo: { path: string; cleanup: () => Promise<void> };
  let privateStore: { path: string; cleanup: () => Promise<void> };
  let keyPair: SamlTestKeyPair;
  const personId = '01951a3c-0000-7000-8000-000000000002';
  const slug = 'sam';

  beforeAll(async () => {
    keyPair = await getSamlTestKeyPair();
    dataRepo = await createFullDataRepo();
    privateStore = await createPrivateStorageDir();
    await seedPerson(dataRepo.path, { id: personId, slug, slackSamlNameId: slug });
    await seedPrivateProfile(privateStore.path, { personId, email: 'sam@example.com' });
  });

  afterAll(async () => {
    await dataRepo.cleanup();
    await privateStore.cleanup();
  });

  it('CFP_SITE_HOST moves the SSO Locations but leaves entityID alone', async () => {
    const app = await buildTestApp(dataRepo.path, privateStore.path, keyPair, {
      CFP_SITE_HOST: 'next.example.org',
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/saml/slack/metadata' });
      expect(res.statusCode).toBe(200);
      const { entityId, locations } = ssoLocations(res.body);
      expect(locations).toHaveLength(2);
      for (const loc of locations) {
        expect(loc).toBe('https://next.example.org/api/saml/slack/sso');
      }
      // The pre-cutover host does not leak into the identifier Slack stores.
      expect(entityId).toBe(DEFAULT_ENTITY_ID);
    } finally {
      await app.close();
    }
  });

  it('SAML_ENTITY_ID overrides both the metadata entityID and the assertion Issuer', async () => {
    const entityId = 'https://idp.example.org/saml/slack';
    const app = await buildTestApp(dataRepo.path, privateStore.path, keyPair, {
      SAML_ENTITY_ID: entityId,
      CFP_SITE_HOST: 'next.example.org',
    });
    try {
      const meta = await app.inject({ method: 'GET', url: '/api/saml/slack/metadata' });
      expect(meta.statusCode).toBe(200);
      expect(ssoLocations(meta.body).entityId).toBe(entityId);

      const { accessToken } = await mintSessionFor(personId, 'user', JWT_KEY);
      const launch = await app.inject({
        method: 'GET',
        url: '/api/saml/slack/launch',
        cookies: { cfp_session: accessToken },
      });
      expect(launch.statusCode).toBe(200);
      expect(issuers(decodeSamlResponse(launch.body))).toEqual([entityId, entityId]);
      // Slack-side values still come from SLACK_TEAM_HOST.
      expect(launch.body).toContain(`action="https://${SLACK_TEAM_HOST}/sso/saml"`);
    } finally {
      await app.close();
    }
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
