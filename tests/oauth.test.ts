import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { OAuthProvider } from '../src/mcp/oauth-provider.js';

const resource = new URL('http://127.0.0.1:4310/mcp');
async function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'comand-oauth-'));
  const provider = new OAuthProvider(dir, resource);
  t.after(() => {
    provider.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const client = await provider.clientsStore.registerClient!({
    redirect_uris: ['https://client.example/callback'],
    token_endpoint_auth_method: 'none',
    client_name: 'Test client',
  });
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const request = provider.createRequest(client, {
    codeChallenge: challenge,
    redirectUri: client.redirect_uris[0]!,
    resource,
    scopes: ['comand:read', 'comand:execute'],
    state: 'original-state',
  });
  const redirect = provider.approveRequest(request.id);
  assert.equal(new URL(redirect).searchParams.get('state'), 'original-state');
  const code = new URL(redirect).searchParams.get('code')!;
  return { provider, client, verifier, code, dir };
}

test('authorization code is bound to PKCE, redirect and resource and consumed once', async (t) => {
  const { provider, client, verifier, code } = await fixture(t);
  await assert.rejects(
    provider.exchangeAuthorizationCode(client, code, 'wrong', client.redirect_uris[0], resource),
  );
  await assert.rejects(
    provider.exchangeAuthorizationCode(
      client,
      code,
      verifier,
      'https://evil.example/callback',
      resource,
    ),
  );
  await assert.rejects(
    provider.exchangeAuthorizationCode(
      client,
      code,
      verifier,
      client.redirect_uris[0],
      new URL('https://evil.example/mcp'),
    ),
  );
  const tokens = await provider.exchangeAuthorizationCode(
    client,
    code,
    verifier,
    client.redirect_uris[0],
    resource,
  );
  const auth = await provider.verifyAccessToken(tokens.access_token);
  assert.equal(auth.clientId, client.client_id);
  assert.equal(auth.resource?.href, resource.href);
  assert.deepEqual(auth.scopes, ['comand:read', 'comand:execute']);
  await assert.rejects(
    provider.exchangeAuthorizationCode(client, code, verifier, client.redirect_uris[0], resource),
  );
});

test('a different registered client cannot exchange a stolen code', async (t) => {
  const { provider, client, verifier, code } = await fixture(t);
  const other = await provider.clientsStore.registerClient!({
    redirect_uris: ['https://client.example/callback'],
    token_endpoint_auth_method: 'none',
  });
  await assert.rejects(
    provider.exchangeAuthorizationCode(other, code, verifier, other.redirect_uris[0], resource),
  );
  const tokens = await provider.exchangeAuthorizationCode(
    client,
    code,
    verifier,
    client.redirect_uris[0],
    resource,
  );
  assert.ok(tokens.access_token);
});

test('refresh rotates once and replay revokes the grant including its new access token', async (t) => {
  const { provider, client, verifier, code } = await fixture(t);
  const first = await provider.exchangeAuthorizationCode(
    client,
    code,
    verifier,
    client.redirect_uris[0],
    resource,
  );
  const second = await provider.exchangeRefreshToken(
    client,
    first.refresh_token!,
    undefined,
    resource,
  );
  assert.notEqual(second.refresh_token, first.refresh_token);
  await provider.verifyAccessToken(second.access_token);
  await assert.rejects(
    provider.exchangeRefreshToken(client, first.refresh_token!, undefined, resource),
  );
  await assert.rejects(provider.verifyAccessToken(second.access_token));
});

test('refresh cannot gain scopes or change audience', async (t) => {
  const { provider, client, verifier, code } = await fixture(t);
  const first = await provider.exchangeAuthorizationCode(
    client,
    code,
    verifier,
    client.redirect_uris[0],
    resource,
  );
  await assert.rejects(
    provider.exchangeRefreshToken(client, first.refresh_token!, ['comand:write'], resource),
  );
  await assert.rejects(
    provider.exchangeRefreshToken(
      client,
      first.refresh_token!,
      undefined,
      new URL('https://other.example/mcp'),
    ),
  );
  const second = await provider.exchangeRefreshToken(
    client,
    first.refresh_token!,
    ['comand:read'],
    resource,
  );
  assert.deepEqual((await provider.verifyAccessToken(second.access_token)).scopes, ['comand:read']);
});

test('client redirects, unexpected scopes and unknown resource are rejected before consent', async (t) => {
  const { provider, client } = await fixture(t);
  await assert.rejects(
    provider.clientsStore.registerClient!({ redirect_uris: ['http://public.example/callback'] }),
  );
  await assert.rejects(
    provider.clientsStore.registerClient!({
      redirect_uris: ['https://client.example/callback#fragment'],
    }),
  );
  await assert.rejects(
    provider.clientsStore.registerClient!({
      redirect_uris: ['https://client.example/callback'],
      token_endpoint_auth_method: 'client_secret_basic',
    }),
  );
  assert.throws(() =>
    provider.createRequest(client, {
      codeChallenge: 'a'.repeat(43),
      redirectUri: client.redirect_uris[0]!,
      scopes: ['admin'],
      resource,
    }),
  );
  assert.throws(() =>
    provider.createRequest(client, {
      codeChallenge: 'a'.repeat(43),
      redirectUri: 'https://evil.example/',
      scopes: ['comand:read'],
      resource,
    }),
  );
  assert.throws(() =>
    provider.createRequest(client, {
      codeChallenge: 'a'.repeat(43),
      redirectUri: client.redirect_uris[0]!,
      scopes: ['comand:read'],
      resource: new URL('https://other.example/mcp'),
    }),
  );
});

test('client registrations and token grants survive provider restart, owner revoke disables access', async (t) => {
  const { provider, client, verifier, code, dir } = await fixture(t);
  const tokens = await provider.exchangeAuthorizationCode(
    client,
    code,
    verifier,
    client.redirect_uris[0],
    resource,
  );
  const reopened = new OAuthProvider(dir, resource);
  t.after(() => reopened.close());
  assert.equal(
    (await reopened.clientsStore.getClient(client.client_id))?.client_id,
    client.client_id,
  );
  await reopened.verifyAccessToken(tokens.access_token);
  const grants = reopened.listGrants();
  assert.equal(grants.length, 1);
  reopened.revokeGrant(grants[0]!.id);
  await assert.rejects(reopened.verifyAccessToken(tokens.access_token));
});
