import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const MAX_TRANSACTION_AGE_MS = 10 * 60 * 1_000;

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function equalText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface OAuthBinding {
  provider: string;
  organizationId: string;
  ventureId: string;
  actorId: string;
  sessionId: string;
}

export interface OAuthTransaction extends OAuthBinding {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  returnPath: string;
  createdAt: string;
  expiresAt: string;
}

export interface OAuthTransactionStore {
  create(transaction: OAuthTransaction): void | Promise<void>;
  consume(state: string): OAuthTransaction | null | Promise<OAuthTransaction | null>;
}

export class InMemoryOAuthTransactionStore implements OAuthTransactionStore {
  readonly #transactions = new Map<string, OAuthTransaction>();

  create(transaction: OAuthTransaction): void {
    if (this.#transactions.has(transaction.state)) throw new Error("OAuth state collision");
    this.#transactions.set(transaction.state, structuredClone(transaction));
  }

  consume(state: string): OAuthTransaction | null {
    const transaction = this.#transactions.get(state) ?? null;
    this.#transactions.delete(state);
    return transaction ? structuredClone(transaction) : null;
  }
}

function exactRedirect(raw: string, allowedRedirectUris: readonly string[]): string {
  let candidate: URL;
  try {
    candidate = new URL(raw);
  } catch {
    throw new Error("OAuth redirect URI is invalid");
  }
  if (
    candidate.protocol !== "https:" ||
    candidate.username ||
    candidate.password ||
    candidate.hash ||
    candidate.origin === "null"
  ) {
    throw new Error("OAuth redirect URI must be an exact credential-free HTTPS URI");
  }
  const canonical = candidate.href;
  if (
    canonical !== raw ||
    !allowedRedirectUris.some((allowed) => {
      try {
        return new URL(allowed).href === allowed && allowed === canonical;
      } catch {
        return false;
      }
    })
  ) {
    throw new Error("OAuth redirect URI is not allowlisted");
  }
  return canonical;
}

function safeReturnPath(value: string): string {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /%(?:2f|5c)/i.test(value)
  ) {
    throw new Error("OAuth return path must be an application-relative path");
  }
  const parsed = new URL(value, "https://return.invalid");
  if (parsed.origin !== "https://return.invalid") {
    throw new Error("OAuth return path must stay inside the application");
  }
  return `${parsed.pathname}${parsed.search}`;
}

export interface BeginOAuthInput extends OAuthBinding {
  redirectUri: string;
  allowedRedirectUris: readonly string[];
  returnPath: string;
  now?: Date;
  maxAgeMs?: number;
  random?: (bytes: number) => Uint8Array;
}

export interface BeginOAuthResult {
  state: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  redirectUri: string;
  expiresAt: string;
}

export async function beginOAuthAuthorization(
  input: BeginOAuthInput,
  store: OAuthTransactionStore,
): Promise<BeginOAuthResult> {
  for (const value of [
    input.provider,
    input.organizationId,
    input.ventureId,
    input.actorId,
    input.sessionId,
  ]) {
    if (!value.trim()) throw new Error("OAuth binding is incomplete");
  }
  const now = input.now ?? new Date();
  const maxAgeMs = input.maxAgeMs ?? MAX_TRANSACTION_AGE_MS;
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1_000 || maxAgeMs > MAX_TRANSACTION_AGE_MS) {
    throw new Error("OAuth transaction lifetime is invalid");
  }
  const random = input.random ?? randomBytes;
  const state = base64Url(random(32));
  const codeVerifier = base64Url(random(64));
  if (state.length < 43 || codeVerifier.length < 43 || codeVerifier.length > 128) {
    throw new Error("OAuth randomness source returned insufficient entropy");
  }
  const redirectUri = exactRedirect(input.redirectUri, input.allowedRedirectUris);
  const expiresAt = new Date(now.getTime() + maxAgeMs).toISOString();
  await store.create({
    provider: input.provider,
    organizationId: input.organizationId,
    ventureId: input.ventureId,
    actorId: input.actorId,
    sessionId: input.sessionId,
    state,
    codeVerifier,
    redirectUri,
    returnPath: safeReturnPath(input.returnPath),
    createdAt: now.toISOString(),
    expiresAt,
  });
  return Object.freeze({
    state,
    codeChallenge: base64Url(createHash("sha256").update(codeVerifier).digest()),
    codeChallengeMethod: "S256",
    redirectUri,
    expiresAt,
  });
}

export interface ConsumeOAuthCallbackInput extends OAuthBinding {
  state: string;
  redirectUri: string;
  allowedRedirectUris: readonly string[];
  code?: string;
  providerError?: string;
  now?: Date;
}

export interface ConsumedOAuthAuthorization {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  returnPath: string;
}

/** Consume state before validating it so every callback attempt is single-use. */
export async function consumeOAuthCallback(
  input: ConsumeOAuthCallbackInput,
  store: OAuthTransactionStore,
): Promise<ConsumedOAuthAuthorization> {
  if (!input.state) throw new Error("OAuth callback was rejected");
  const transaction = await store.consume(input.state);
  if (!transaction) throw new Error("OAuth callback was rejected");
  if (input.providerError || !input.code?.trim()) throw new Error("OAuth callback was rejected");
  const redirectUri = exactRedirect(input.redirectUri, input.allowedRedirectUris);
  const bindings: Array<[string, string]> = [
    [transaction.state, input.state],
    [transaction.provider, input.provider],
    [transaction.organizationId, input.organizationId],
    [transaction.ventureId, input.ventureId],
    [transaction.actorId, input.actorId],
    [transaction.sessionId, input.sessionId],
    [transaction.redirectUri, redirectUri],
  ];
  const bindingValid = bindings.every(([expected, actual]) => equalText(expected, actual));
  const now = input.now ?? new Date();
  if (!bindingValid || now.getTime() >= Date.parse(transaction.expiresAt)) {
    throw new Error("OAuth callback was rejected");
  }
  return Object.freeze({
    code: input.code,
    codeVerifier: transaction.codeVerifier,
    redirectUri: transaction.redirectUri,
    returnPath: transaction.returnPath,
  });
}
