import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { AssetRecord } from "../../packages/assets/src/index";
import {
  SqliteIdempotencyStore,
  type IdempotencyAmbiguousFailure,
  type IdempotencyArtifactsCompletion,
  type IdempotencyClaim,
  type IdempotencyClaimInput,
  type IdempotencyCompletion,
  type IdempotencyRetryableFailure,
  type IdempotencyStore,
} from "../../packages/command-bus/src/index";
import {
  assertCredentialFree,
  stableJson,
  tenantKey,
  type JsonObject,
  type JsonValue,
  type TenantRef,
} from "../../packages/core/src/index";
import {
  assertCredentialAccess,
  type ScopedCredentialReference,
} from "../../packages/credentials/src/index";
import {
  defineCapability,
  type CapabilityRequest,
  type CapabilityResult,
  type ProviderCapabilityAdapter,
} from "@venture-harness/provider-sdk";
import { ProviderCapabilityRegistry, type StackProfile } from "@venture-harness/provider-registry";
import {
  assertSafeWinnerProviderFixtureRecord,
  assertSafeWinnerProviderOutput,
  createWinnerProviderFixtureAdapters,
  type FixtureJsonObject,
  type WinnerProviderAdapter,
  type WinnerProviderAdapterId,
  type WinnerProviderFeature,
  type WinnerProviderFixtureContext,
  type WinnerProviderFixtureRecord,
  type WinnerProviderFixtureStore,
  type WinnerProviderPlan,
} from "./providers";

export const WINNER_FIXTURE_CAPABILITY_BY_FEATURE = Object.freeze({
  creative_render: "creative.video.generate",
  organic_create_draft: "distribution.content.draft",
  organic_publish_direct: "distribution.content.publish",
  paid_promote_existing_post_contract: "ads.organic-post.boost",
  attribution_read_aggregates: "attribution.campaign.read",
  subscription_read_lifecycle: "subscription.lifecycle.read",
} satisfies Readonly<Record<WinnerProviderFeature, string>>);

const FEATURE_BY_CAPABILITY = new Map<string, WinnerProviderFeature>(
  Object.entries(WINNER_FIXTURE_CAPABILITY_BY_FEATURE).map(([feature, capability]) => [
    capability,
    feature as WinnerProviderFeature,
  ]),
);

const FIXTURE_PROFILE_ID = "winner-loop-fixture-v1";
const FIXTURE_SCOPE = "winner.fixture.execute";

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function providerTenantKey(tenant: TenantRef): string {
  const key = tenantKey(tenant);
  if (tenant.organizationId === "__legacy_unscoped__") {
    throw new Error("legacy unscoped fixture provider record rejected");
  }
  return key;
}

interface FixtureSqliteStatement {
  all(...values: unknown[]): unknown[];
  get(...values: unknown[]): unknown;
  run(...values: unknown[]): unknown;
}

interface FixtureSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): FixtureSqliteStatement;
  close(): void;
}

interface FixtureProviderRow {
  tenant_key: string;
  adapter_id: string;
  idempotency_key: string;
  request_hash: string;
  record_json: string;
}

const SQLITE_HEADER = "SQLite format 3\u0000";
const SQLITE_RETRY_SIGNAL = new Int32Array(new SharedArrayBuffer(4));

function sqliteBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    /(?:database is (?:busy|locked)|SQLITE_BUSY|SQLITE_LOCKED)/iu.test(error.message)
  );
}

function withBoundedSqliteRetry<T>(label: string, operation: () => T): T {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (!sqliteBusy(error)) throw error;
      if (attempt === 49) throw new Error(`${label} remained busy after bounded retry`);
      Atomics.wait(SQLITE_RETRY_SIGNAL, 0, 0, 10);
    }
  }
  throw new Error(`${label} remained busy after bounded retry`);
}

function assertDurableSqlitePath(path: string, label: string): void {
  if (!path.trim() || path === ":memory:") {
    throw new Error(`${label} requires a filesystem path`);
  }
  if (!existsSync(path) || statSync(path).size === 0) return;
  const descriptor = openSync(path, "r");
  try {
    const header = Buffer.alloc(SQLITE_HEADER.length);
    const bytesRead = readSync(descriptor, header, 0, header.length, 0);
    if (bytesRead !== header.length || header.toString("utf8") !== SQLITE_HEADER) {
      throw new Error(`${label} rejected legacy unsafe non-SQLite data`);
    }
  } finally {
    closeSync(descriptor);
  }
}

function fixtureSqliteDatabase(path: string, label: string): FixtureSqliteDatabase {
  assertDurableSqlitePath(path, label);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let DatabaseSync: new (filename: string) => FixtureSqliteDatabase;
  try {
    ({ DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (filename: string) => FixtureSqliteDatabase;
    });
  } catch (error) {
    throw new Error(`${label} requires Node >= 22.5 SQLite support: ${(error as Error).message}`);
  }
  const database = withBoundedSqliteRetry(`${label} open`, () => new DatabaseSync(path));
  try {
    database.exec("PRAGMA busy_timeout = 100");
    withBoundedSqliteRetry(`${label} WAL initialization`, () =>
      database.exec("PRAGMA journal_mode = WAL"),
    );
    database.exec("PRAGMA synchronous = FULL");
    chmodSync(path, 0o600);
    return database;
  } catch (error) {
    database.close();
    if (sqliteBusy(error)) throw new Error(`${label} initialization remained busy`);
    throw error;
  }
}

function fixtureProviderDatabase(path: string): FixtureSqliteDatabase {
  const database = fixtureSqliteDatabase(path, "fixture provider store");
  try {
    withBoundedSqliteRetry("fixture provider store schema initialization", () =>
      database.exec(`
        CREATE TABLE IF NOT EXISTS winner_fixture_provider_records (
          tenant_key TEXT NOT NULL,
          organization_id TEXT NOT NULL,
          venture_id TEXT NOT NULL,
          adapter_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          record_json TEXT NOT NULL,
          PRIMARY KEY (tenant_key, adapter_id, idempotency_key),
          CHECK (length(request_hash) = 64)
        )
      `),
    );
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function providerRecordFromRow(row: FixtureProviderRow): WinnerProviderFixtureRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.record_json);
  } catch {
    throw new Error("unsafe fixture provider record rejected");
  }
  try {
    assertSafeWinnerProviderFixtureRecord(parsed);
  } catch {
    throw new Error("unsafe fixture provider record rejected");
  }
  if (
    providerTenantKey(parsed.tenant) !== row.tenant_key ||
    parsed.adapterId !== row.adapter_id ||
    parsed.idempotencyKey !== row.idempotency_key ||
    parsed.requestHash !== row.request_hash
  ) {
    throw new Error("fixture provider record identity binding is corrupt");
  }
  return jsonClone(parsed);
}

/** Durable fixture-only state used by the package SDK adapter bridge. */
export function createFileWinnerProviderFixtureStore(path: string): WinnerProviderFixtureStore {
  return Object.freeze({
    get(
      tenant: TenantRef,
      adapterId: WinnerProviderAdapterId,
      idempotencyKey: string,
    ): WinnerProviderFixtureRecord | undefined {
      const database = fixtureProviderDatabase(path);
      try {
        const row = database
          .prepare(
            `SELECT tenant_key, adapter_id, idempotency_key, request_hash, record_json
               FROM winner_fixture_provider_records
              WHERE tenant_key = ? AND adapter_id = ? AND idempotency_key = ?`,
          )
          .get(providerTenantKey(tenant), adapterId, idempotencyKey) as
          FixtureProviderRow | undefined;
        return row ? providerRecordFromRow(row) : undefined;
      } finally {
        database.close();
      }
    },
    put(record: WinnerProviderFixtureRecord): void {
      try {
        assertSafeWinnerProviderFixtureRecord(record);
      } catch {
        throw new Error("unsafe fixture provider record rejected");
      }
      const database = fixtureProviderDatabase(path);
      withBoundedSqliteRetry("fixture provider store transaction", () =>
        database.exec("BEGIN IMMEDIATE"),
      );
      try {
        const tenant = providerTenantKey(record.tenant);
        const existing = database
          .prepare(
            `SELECT tenant_key, adapter_id, idempotency_key, request_hash, record_json
               FROM winner_fixture_provider_records
              WHERE tenant_key = ? AND adapter_id = ? AND idempotency_key = ?`,
          )
          .get(tenant, record.adapterId, record.idempotencyKey) as FixtureProviderRow | undefined;
        if (existing) {
          providerRecordFromRow(existing);
          if (existing.request_hash !== record.requestHash) {
            throw new Error("fixture provider idempotency key is bound to different input");
          }
        } else {
          database
            .prepare(
              `INSERT INTO winner_fixture_provider_records
                 (tenant_key, organization_id, venture_id, adapter_id, idempotency_key,
                  request_hash, record_json)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              tenant,
              record.tenant.organizationId,
              record.tenant.ventureId,
              record.adapterId,
              record.idempotencyKey,
              record.requestHash,
              stableJson(record as unknown as JsonValue),
            );
        }
        database.exec("COMMIT");
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // Preserve the original transactional failure.
        }
        throw error;
      } finally {
        database.close();
      }
    },
    size() {
      const database = fixtureProviderDatabase(path);
      try {
        const rows = database
          .prepare(
            `SELECT tenant_key, adapter_id, idempotency_key, request_hash, record_json
               FROM winner_fixture_provider_records`,
          )
          .all() as FixtureProviderRow[];
        for (const row of rows) providerRecordFromRow(row);
        return rows.length;
      } finally {
        database.close();
      }
    },
  });
}

export class FileFixtureCommandIdempotencyStore implements IdempotencyStore {
  readonly durability = "fixture_only" as const;
  readonly #delegate: SqliteIdempotencyStore;

  constructor(
    readonly path: string,
    options: { pendingTimeoutMs?: number } = {},
  ) {
    assertDurableSqlitePath(path, "fixture command idempotency store");
    const initializer = fixtureSqliteDatabase(path, "fixture command idempotency store");
    initializer.close();
    this.#delegate = withBoundedSqliteRetry(
      "fixture command idempotency initialization",
      () => new SqliteIdempotencyStore(path, options),
    );
  }

  claim(key: string, input: IdempotencyClaimInput): IdempotencyClaim {
    const claim = this.#delegate.claim(key, input);
    if (claim.kind === "replay") {
      assertFixtureCommandOutputSafe(claim.record.output);
      return jsonClone(claim);
    }
    return claim;
  }

  complete(key: string, value: IdempotencyCompletion): void {
    assertFixtureCommandOutputSafe(value.output);
    this.#delegate.complete(key, value);
  }

  markAmbiguous(key: string, value: IdempotencyAmbiguousFailure): void {
    this.#delegate.markAmbiguous(key, value);
  }

  markArtifactsEmitted(key: string, value: IdempotencyArtifactsCompletion): void {
    this.#delegate.markArtifactsEmitted(key, value);
  }

  release(key: string, value: IdempotencyRetryableFailure): void {
    this.#delegate.release(key, value);
  }

  close(): void {
    this.#delegate.close();
  }
}

function assertFixtureCommandOutputSafe(value: JsonValue): void {
  try {
    assertCredentialFree(value, "fixture command output");
  } catch {
    throw new Error("unsafe fixture command output rejected");
  }
}

interface FixtureAssetRow {
  tenant_key: string;
  organization_id: string;
  venture_id: string;
  asset_id: string;
  media_type: string;
  sha256: string;
  bytes: Uint8Array;
}

const SAFE_ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;
const SAFE_MEDIA_TYPE = /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/u;

function assertFixtureAssetIdentity(
  tenant: TenantRef,
  assetId: string,
  mediaType?: string,
): string {
  const tenantIdentity = providerTenantKey(tenant);
  if (!SAFE_ASSET_ID.test(assetId)) throw new Error("fixture asset id must be a safe opaque value");
  if (mediaType !== undefined && !SAFE_MEDIA_TYPE.test(mediaType)) {
    throw new Error("fixture asset media type is invalid");
  }
  return tenantIdentity;
}

function fixtureAssetDatabase(path: string): FixtureSqliteDatabase {
  const database = fixtureSqliteDatabase(path, "fixture asset store");
  try {
    withBoundedSqliteRetry("fixture asset store schema initialization", () =>
      database.exec(`
        CREATE TABLE IF NOT EXISTS winner_fixture_assets (
          tenant_key TEXT NOT NULL,
          organization_id TEXT NOT NULL,
          venture_id TEXT NOT NULL,
          asset_id TEXT NOT NULL,
          media_type TEXT NOT NULL,
          sha256 TEXT NOT NULL,
          bytes BLOB NOT NULL,
          PRIMARY KEY (tenant_key, asset_id),
          CHECK (length(sha256) = 64)
        )
      `),
    );
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function assetRecordFromRow(row: FixtureAssetRow): AssetRecord {
  const tenant = {
    organizationId: row.organization_id,
    ventureId: row.venture_id,
  };
  if (
    assertFixtureAssetIdentity(tenant, row.asset_id, row.media_type) !== row.tenant_key ||
    !/^[a-f0-9]{64}$/u.test(row.sha256)
  ) {
    throw new Error("fixture asset identity binding is corrupt");
  }
  const bytes = Uint8Array.from(row.bytes);
  if (createHash("sha256").update(bytes).digest("hex") !== row.sha256) {
    throw new Error("fixture asset content binding is corrupt");
  }
  return {
    assetId: row.asset_id,
    tenant,
    mediaType: row.media_type,
    sha256: row.sha256,
    bytes,
  };
}

export class FileFixtureAssetVault {
  constructor(readonly path: string) {
    assertDurableSqlitePath(path, "fixture asset store");
  }

  put(tenant: TenantRef, assetId: string, mediaType: string, bytes: Uint8Array): AssetRecord {
    const tenantIdentity = assertFixtureAssetIdentity(tenant, assetId, mediaType);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const database = fixtureAssetDatabase(this.path);
    withBoundedSqliteRetry("fixture asset store transaction", () =>
      database.exec("BEGIN IMMEDIATE"),
    );
    try {
      const existing = database
        .prepare(
          `SELECT tenant_key, organization_id, venture_id, asset_id, media_type, sha256, bytes
             FROM winner_fixture_assets
            WHERE tenant_key = ? AND asset_id = ?`,
        )
        .get(tenantIdentity, assetId) as FixtureAssetRow | undefined;
      if (existing) {
        assetRecordFromRow(existing);
        if (existing.sha256 !== sha256 || existing.media_type !== mediaType) {
          throw new Error("fixture asset id is already bound to different content");
        }
      } else {
        database
          .prepare(
            `INSERT INTO winner_fixture_assets
               (tenant_key, organization_id, venture_id, asset_id, media_type, sha256, bytes)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            tenantIdentity,
            tenant.organizationId,
            tenant.ventureId,
            assetId,
            mediaType,
            sha256,
            Buffer.from(bytes),
          );
      }
      database.exec("COMMIT");
      return {
        assetId,
        tenant: jsonClone(tenant),
        mediaType,
        sha256,
        bytes: Uint8Array.from(bytes),
      };
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original transactional failure.
      }
      throw error;
    } finally {
      database.close();
    }
  }

  get(tenant: TenantRef, assetId: string): AssetRecord | null {
    const tenantIdentity = assertFixtureAssetIdentity(tenant, assetId);
    const database = fixtureAssetDatabase(this.path);
    try {
      const row = database
        .prepare(
          `SELECT tenant_key, organization_id, venture_id, asset_id, media_type, sha256, bytes
             FROM winner_fixture_assets
            WHERE tenant_key = ? AND asset_id = ?`,
        )
        .get(tenantIdentity, assetId) as FixtureAssetRow | undefined;
      return row ? assetRecordFromRow(row) : null;
    } finally {
      database.close();
    }
  }
}

function featureForRequest(request: CapabilityRequest): WinnerProviderFeature {
  const feature = FEATURE_BY_CAPABILITY.get(request.capability);
  if (!feature) throw new Error(`unsupported Winner fixture capability ${request.capability}`);
  return feature;
}

function operationId(request: CapabilityRequest): string {
  const supplied = request.input.operation_id;
  return typeof supplied === "string" && supplied.trim()
    ? supplied
    : `fixture-sdk-${createHash("sha256").update(request.idempotencyKey).digest("hex").slice(0, 16)}`;
}

function fixturePayload(request: CapabilityRequest): FixtureJsonObject {
  const payload = request.input.payload;
  if (!payload || Array.isArray(payload) || typeof payload !== "object") {
    throw new Error("Winner fixture capability input.payload must be an object");
  }
  return jsonClone(payload) as FixtureJsonObject;
}

class WinnerFixtureCapabilityAdapter implements ProviderCapabilityAdapter {
  readonly capabilities;

  constructor(
    readonly providerId: WinnerProviderAdapterId,
    private readonly adapter: WinnerProviderAdapter,
    private readonly fixtureContext: WinnerProviderFixtureContext,
  ) {
    this.capabilities = Object.freeze(
      this.adapter.descriptor.features.map((declaration) =>
        defineCapability({
          id: WINNER_FIXTURE_CAPABILITY_BY_FEATURE[declaration.feature],
          schemaVersion: 1,
          inputSchema: {
            type: "object",
            required: ["payload"],
            properties: { operation_id: { type: "string" }, payload: { type: "object" } },
          },
          outputSchema: { type: "object" },
          environments: ["fixture"],
          requiredScopes: declaration.credentialRequired ? [FIXTURE_SCOPE] : [],
          rateClass: "fixture_local",
          concurrencyGroup: `winner-fixture:${this.providerId}`,
          timeoutMs: 10_000,
          redactionPaths: ["credential"],
          unknownOutcome: "manual_reconcile",
        }),
      ),
    );
  }

  private descriptor(request: CapabilityRequest) {
    const descriptor = this.capabilities.find(({ id }) => id === request.capability);
    if (!descriptor) throw new Error(`${this.providerId} does not implement ${request.capability}`);
    if (!descriptor.environments.includes(request.environment)) {
      throw new Error(`${request.capability} is unavailable in ${request.environment}`);
    }
    return descriptor;
  }

  private context(request: CapabilityRequest): WinnerProviderFixtureContext {
    const descriptor = this.descriptor(request);
    let credential: ScopedCredentialReference | undefined;
    if (descriptor.requiredScopes.length > 0) {
      if (!request.credential) throw new Error(`${request.capability} requires a credential`);
      if (request.credential.provider !== this.providerId) {
        throw new Error("credential provider does not match resolved adapter");
      }
      credential = assertCredentialAccess(
        request.credential,
        request.tenant,
        descriptor.requiredScopes,
        (this.fixtureContext.now ?? (() => new Date()))(),
      );
    }
    return {
      ...this.fixtureContext,
      fixtureExecution: true,
      credentialRefs: credential ? { [this.providerId]: credential.ref } : {},
    };
  }

  private winnerPlan(request: CapabilityRequest): WinnerProviderPlan {
    const feature = featureForRequest(request);
    return this.adapter.plan(
      {
        tenant: jsonClone(request.tenant),
        operationId: operationId(request),
        idempotencyKey: request.idempotencyKey,
        feature,
        payload: fixturePayload(request),
      },
      this.context(request),
    );
  }

  async discover(request: CapabilityRequest): Promise<JsonObject> {
    const feature = featureForRequest(request);
    const doctor = await this.adapter.doctor(this.context(request), [feature]);
    return {
      providerId: this.providerId,
      capability: request.capability,
      profileFixtureOnly: true,
      status: doctor.status,
      packageSdk: "@venture-harness/provider-sdk",
    };
  }

  async estimate(request: CapabilityRequest) {
    this.descriptor(request);
    return { amount: 0, currency: "USD", known: true };
  }

  async plan(request: CapabilityRequest): Promise<JsonObject> {
    return jsonClone(this.winnerPlan(request)) as unknown as JsonObject;
  }

  async apply(request: CapabilityRequest, suppliedPlan: JsonObject): Promise<CapabilityResult> {
    const expected = this.winnerPlan(request);
    if (stableJson(suppliedPlan) !== stableJson(jsonClone(expected) as unknown as JsonValue)) {
      throw new Error("fixture SDK plan does not match the canonical request-bound plan");
    }
    const applied = await this.adapter.apply(expected, this.context(request));
    if (applied.output) assertSafeWinnerProviderOutput(expected.feature, applied.output);
    const state =
      applied.state === "succeeded"
        ? "applied"
        : applied.state === "blocked" || applied.state === "conflict"
          ? "failed"
          : applied.state === "planned"
            ? "planned"
            : "failed";
    return {
      state,
      output: applied.output ? (jsonClone(applied.output) as JsonValue) : undefined,
      evidence: {
        providerId: this.providerId,
        operationId: applied.operationId,
        capability: request.capability,
        reused: applied.reused,
        providerInvoked: false,
        externalEffectOccurred: false,
        fixtureOnly: true,
        packageSdk: "@venture-harness/provider-sdk",
      },
      retryable: false,
    };
  }

  async readBack(request: CapabilityRequest, _result: CapabilityResult): Promise<CapabilityResult> {
    void _result;
    const plan = this.winnerPlan(request);
    const readBack = await this.adapter.readBack(plan);
    const verified = await this.adapter.verify(plan);
    if (readBack.evidence) assertSafeWinnerProviderOutput(plan.feature, readBack.evidence);
    if (verified.evidence) assertSafeWinnerProviderOutput(plan.feature, verified.evidence);
    const matched = readBack.state === "matched" && verified.state === "verified_fixture";
    return {
      state: matched ? "verified" : readBack.state === "missing" ? "unknown" : "failed",
      output: readBack.evidence ? (jsonClone(readBack.evidence) as JsonValue) : undefined,
      evidence: {
        providerId: this.providerId,
        operationId: plan.operationId,
        capability: request.capability,
        readBack: readBack.state,
        verify: verified.state,
        fixtureOnly: true,
        liveVerified: false,
      },
      retryable: false,
    };
  }

  async reconcile(request: CapabilityRequest): Promise<CapabilityResult> {
    const plan = this.winnerPlan(request);
    const reconciled = await this.adapter.reconcile(plan);
    return {
      state: reconciled.state === "matched" ? "verified" : "unknown",
      evidence: {
        providerId: this.providerId,
        operationId: plan.operationId,
        capability: request.capability,
        reconcile: reconciled.state,
        reapplied: reconciled.reapplied,
        fixtureOnly: true,
        liveVerified: false,
      },
      retryable: false,
    };
  }

  async compensate(
    request: CapabilityRequest,
    _result: CapabilityResult,
  ): Promise<CapabilityResult> {
    void _result;
    this.descriptor(request);
    return {
      state: "compensated",
      evidence: {
        providerId: this.providerId,
        capability: request.capability,
        fixtureOnly: true,
        externalEffectOccurred: false,
      },
      retryable: false,
    };
  }
}

export interface WinnerFixtureCapabilityRuntime {
  registry: ProviderCapabilityRegistry;
  profile: StackProfile;
  providerStore: WinnerProviderFixtureStore;
}

export function createWinnerFixtureCapabilityRuntime(options: {
  storePath: string;
  context: WinnerProviderFixtureContext;
}): WinnerFixtureCapabilityRuntime {
  const providerStore = createFileWinnerProviderFixtureStore(options.storePath);
  const fixtureAdapters = createWinnerProviderFixtureAdapters({ store: providerStore });
  const registry = new ProviderCapabilityRegistry();
  for (const [providerId, adapter] of Object.entries(fixtureAdapters) as Array<
    [WinnerProviderAdapterId, WinnerProviderAdapter]
  >) {
    registry.register(new WinnerFixtureCapabilityAdapter(providerId, adapter, options.context));
  }
  const providersByCapability = Object.fromEntries(
    Object.entries(WINNER_FIXTURE_CAPABILITY_BY_FEATURE).map(([feature, capability]) => {
      const provider = Object.values(fixtureAdapters).find((candidate) =>
        candidate.descriptor.features.some((declaration) => declaration.feature === feature),
      );
      if (!provider) throw new Error(`no fixture provider implements ${feature}`);
      return [capability, [provider.descriptor.id]];
    }),
  );
  return {
    registry,
    profile: Object.freeze({ profileId: FIXTURE_PROFILE_ID, providersByCapability }),
    providerStore,
  };
}

export function fixtureCapabilityCredential(
  tenant: TenantRef,
  provider: WinnerProviderAdapterId,
): ScopedCredentialReference {
  return {
    ref: `cred://fixture/${provider}`,
    tenant: jsonClone(tenant),
    provider,
    scopes: [FIXTURE_SCOPE],
    expiresAt: "2026-08-10T00:00:00.000Z",
  };
}
