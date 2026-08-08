import {
  createPlan,
  credentialInput,
  hasCapability,
  idempotencyKey,
  inputBoolean,
  inputNumber,
  inputString,
  inputStrings,
  operationId,
  optionalNumber,
  optionalString,
} from "./plan-helpers";
import type {
  JsonValue,
  ProviderEffectClass,
  ProviderId,
  ProviderOperation,
  ProviderPlan,
  ProviderPlanRequest,
  ProviderReversibility,
  ProviderRiskClass,
} from "./types";

interface OperationInput {
  provider: ProviderId;
  capability: string;
  action: string;
  title: string;
  identity: unknown;
  riskClass: ProviderRiskClass;
  effectClass: ProviderEffectClass;
  reversibility: ProviderReversibility;
  credentialRef?: string;
  reconcileOnReplay?: boolean;
  dependsOn?: readonly string[];
  command?: ProviderOperation["command"];
  http?: ProviderOperation["http"];
  manual?: ProviderOperation["manual"];
  readBack?: ProviderOperation["readBack"];
  verification: ProviderOperation["verification"];
  estimatedCost?: ProviderOperation["estimatedCost"];
  emailRecipientCount?: number;
}

function operation(request: ProviderPlanRequest, input: OperationInput): ProviderOperation {
  const id = operationId(input.provider, input.action, {
    environment: request.environment,
    identity: input.identity,
  });
  return {
    id,
    provider: input.provider,
    capability: input.capability,
    action: input.action,
    title: input.title,
    transport: input.command ? "cli" : input.http ? "http" : "manual",
    environment: request.environment,
    riskClass: input.riskClass,
    effectClass: input.effectClass,
    reversibility: input.reversibility,
    credentialRef: input.credentialRef,
    reconcileOnReplay: input.reconcileOnReplay,
    idempotencyKey: idempotencyKey(input.provider, request.environment, input.action, {
      identity: input.identity,
      command: input.command,
      http: input.http,
      manual: input.manual,
    }),
    dependsOn: input.dependsOn ?? [],
    command: input.command,
    http: input.http,
    manual: input.manual,
    readBack: input.readBack,
    verification: input.verification,
    estimatedCost: input.estimatedCost,
    emailRecipientCount: input.emailRecipientCount,
  };
}

function encoded(value: string): string {
  return encodeURIComponent(value);
}

export function buildGitHubPlan(request: ProviderPlanRequest): ProviderPlan {
  const operations: ProviderOperation[] = [];
  if (hasCapability(request, "repository")) {
    const repository = inputString(request, "repository");
    const visibility = optionalString(request, "visibility") ?? "private";
    const sourceDirectory = optionalString(request, "sourceDirectory") ?? ".";
    if (!["private", "public", "internal"].includes(visibility)) {
      throw new Error(`Unsupported GitHub repository visibility: ${visibility}`);
    }
    operations.push(
      operation(request, {
        provider: "github",
        capability: "repository",
        action: "repository.create_from_source",
        title: `Publish the verified local source tree to ${repository}`,
        identity: { repository, sourceDirectory, visibility },
        riskClass: "high",
        effectClass: "reversible_external",
        reversibility: "conditionally_reversible",
        credentialRef: request.credentialRef,
        reconcileOnReplay: true,
        command: {
          binary: "node",
          args: [
            "--import",
            "tsx",
            "scripts/github-publish-source.ts",
            "apply",
            "--repository",
            repository,
            "--visibility",
            visibility,
          ],
          cwd: sourceDirectory,
        },
        readBack: {
          transport: "cli",
          command: {
            binary: "node",
            args: [
              "--import",
              "tsx",
              "scripts/github-publish-source.ts",
              "verify",
              "--repository",
              repository,
              "--visibility",
              visibility,
              "--branch",
              "{result.branch}",
              "--commit",
              "{result.commitOid}",
              "--tree",
              "{result.treeOid}",
            ],
            cwd: sourceDirectory,
          },
          description:
            "GitHub returned the exact repository, visibility, default branch, commit, and source tree",
          assertions: [
            { path: "verified", operator: "equals", expected: true },
            { path: "repository", operator: "equals", expected: repository },
            { path: "visibility", operator: "equals", expected: visibility },
            { path: "branch", operator: "equals", expected: "{result.branch}" },
            { path: "commitOid", operator: "equals", expected: "{result.commitOid}" },
            { path: "treeOid", operator: "equals", expected: "{result.treeOid}" },
          ],
        },
        verification: {
          strategy: "response_then_read_back",
          description:
            "Read the remote default branch and exact commit/tree back after source publication",
        },
      }),
    );
  }
  if (hasCapability(request, "actions_secret")) {
    const repository = inputString(request, "repository");
    const secretName = inputString(request, "secretName");
    const secretCredentialRef = credentialInput(request, "secretCredentialRef");
    operations.push(
      operation(request, {
        provider: "github",
        capability: "actions_secret",
        action: "actions_secret.set",
        title: `Set Actions secret metadata ${secretName}`,
        identity: { repository, secretName },
        riskClass: "critical",
        effectClass: "reversible_external",
        reversibility: "conditionally_reversible",
        credentialRef: request.credentialRef,
        command: {
          binary: "gh",
          args: ["secret", "set", secretName, "--repo", repository],
          stdinCredentialRef: secretCredentialRef,
        },
        readBack: {
          transport: "cli",
          command: {
            binary: "gh",
            args: ["secret", "list", "--repo", repository, "--json", "name,updatedAt"],
          },
          description: "GitHub lists the secret name and timestamp; the value remains unreadable",
          assertions: [{ path: "", operator: "contains", expected: { name: secretName } }],
        },
        verification: {
          strategy: "read_back",
          description: "Verify write-only secret metadata, never its value",
        },
      }),
    );
  }
  if (hasCapability(request, "repository_settings")) {
    const repository = inputString(request, "repository");
    const deleteBranchOnMerge = inputBoolean(request, "deleteBranchOnMerge", true);
    operations.push(
      operation(request, {
        provider: "github",
        capability: "repository_settings",
        action: "repository.settings.update",
        title: `Update merge settings for ${repository}`,
        identity: repository,
        riskClass: "medium",
        effectClass: "reversible_external",
        reversibility: "reversible",
        credentialRef: request.credentialRef,
        command: {
          binary: "gh",
          args: [
            "api",
            `repos/${repository}`,
            "--method",
            "PATCH",
            "-F",
            `delete_branch_on_merge=${deleteBranchOnMerge}`,
          ],
        },
        readBack: {
          transport: "cli",
          command: {
            binary: "gh",
            args: ["api", `repos/${repository}`],
          },
          description: "GitHub repository settings are readable after the update",
          assertions: [
            {
              path: "delete_branch_on_merge",
              operator: "equals",
              expected: deleteBranchOnMerge,
            },
          ],
        },
        verification: {
          strategy: "read_back",
          description: "Compare delete_branch_on_merge with the requested value",
        },
      }),
    );
  }
  if (hasCapability(request, "draft_pull_request")) {
    const repository = inputString(request, "repository");
    const base = optionalString(request, "baseBranch") ?? "main";
    const head = inputString(request, "headBranch");
    const title = inputString(request, "pullRequestTitle");
    const body = inputString(request, "pullRequestBody");
    operations.push(
      operation(request, {
        provider: "github",
        capability: "draft_pull_request",
        action: "pull_request.create_draft",
        title: `Open draft pull request from ${head}`,
        identity: { repository, base, head },
        riskClass: "medium",
        effectClass: "reversible_external",
        reversibility: "reversible",
        credentialRef: request.credentialRef,
        command: {
          binary: "gh",
          args: [
            "pr",
            "create",
            "--repo",
            repository,
            "--draft",
            "--base",
            base,
            "--head",
            head,
            "--title",
            title,
            "--body",
            body,
          ],
        },
        readBack: {
          transport: "cli",
          command: {
            binary: "gh",
            args: [
              "pr",
              "view",
              head,
              "--repo",
              repository,
              "--json",
              "url,isDraft,baseRefName,headRefName,state",
            ],
          },
          description: "GitHub returned the draft pull request and branch metadata",
          assertions: [
            { path: "isDraft", operator: "equals", expected: true },
            { path: "baseRefName", operator: "equals", expected: base },
            { path: "headRefName", operator: "equals", expected: head },
          ],
        },
        verification: {
          strategy: "response_then_read_back",
          description: "Confirm the PR exists, remains a draft, and targets the right base",
        },
      }),
    );
  }
  return createPlan("github", request, operations, [
    "Actions secret verification is metadata-only.",
  ]);
}

export function buildVercelPlan(request: ProviderPlanRequest): ProviderPlan {
  const operations: ProviderOperation[] = [];
  if (hasCapability(request, "project")) {
    const project = inputString(request, "project");
    const scope = optionalString(request, "scope");
    const projectIntent = optionalString(request, "projectIntent") ?? "use_verified";
    if (!["create", "use_verified"].includes(projectIntent)) {
      throw new Error(`Unsupported Vercel project intent: ${projectIntent}`);
    }
    let createOperationId: string | undefined;
    if (projectIntent === "create") {
      const createArgs = ["project", "add", project];
      if (scope) createArgs.push("--scope", scope);
      const createProject = operation(request, {
        provider: "vercel",
        capability: "project",
        action: "project.create",
        title: `Create Vercel project ${project}`,
        identity: { project, scope },
        riskClass: "high",
        effectClass: "reversible_external",
        reversibility: "conditionally_reversible",
        credentialRef: request.credentialRef,
        command: { binary: "vercel", args: createArgs },
        readBack: {
          transport: "cli",
          command: {
            binary: "vercel",
            args: ["project", "inspect", project, ...(scope ? ["--scope", scope] : [])],
          },
          description: "Vercel returned the newly created project metadata",
          assertions: [{ path: "", operator: "contains", expected: project }],
        },
        verification: {
          strategy: "response_then_read_back",
          description: "Create the named project, then inspect it in the explicit account scope",
        },
      });
      createOperationId = createProject.id;
      operations.push(createProject);
    }
    const args = ["link", "--yes", "--project", project];
    if (scope) args.push("--scope", scope);
    operations.push(
      operation(request, {
        provider: "vercel",
        capability: "project",
        action: "project.link",
        title: `Link the workspace to Vercel project ${project}`,
        identity: { project, scope, projectIntent },
        riskClass: "high",
        effectClass: "local_write",
        reversibility: "reversible",
        credentialRef: request.credentialRef,
        dependsOn: createOperationId ? [createOperationId] : [],
        command: { binary: "vercel", args },
        readBack: {
          transport: "cli",
          command: {
            binary: "vercel",
            args: ["project", "inspect", project, ...(scope ? ["--scope", scope] : [])],
          },
          description: "Vercel returned the linked project metadata",
          assertions: [{ path: "", operator: "contains", expected: project }],
        },
        verification: {
          strategy: "read_back",
          description: "Inspect the project and compare its name and scope",
        },
      }),
    );
  }
  if (hasCapability(request, "environment_variable")) {
    const project = inputString(request, "project");
    const name = inputString(request, "environmentVariableName");
    const target = optionalString(request, "environmentTarget") ?? "production";
    const valueRef = credentialInput(request, "environmentValueCredentialRef");
    operations.push(
      operation(request, {
        provider: "vercel",
        capability: "environment_variable",
        action: "environment_variable.set",
        title: `Set Vercel environment variable ${name}`,
        identity: { project, name, target },
        riskClass: "critical",
        effectClass: "reversible_external",
        reversibility: "conditionally_reversible",
        credentialRef: request.credentialRef,
        command: {
          binary: "vercel",
          args: ["env", "add", name, target, "--force"],
          stdinCredentialRef: valueRef,
        },
        readBack: {
          transport: "cli",
          command: { binary: "vercel", args: ["env", "ls", target] },
          description: "Vercel lists the variable name and target; its value remains unreadable",
          assertions: [{ path: "", operator: "contains", expected: name }],
        },
        verification: {
          strategy: "read_back",
          description: "Verify variable metadata without exposing its value",
        },
      }),
    );
  }
  if (hasCapability(request, "deployment")) {
    const production = request.environment === "production";
    const project = optionalString(request, "project");
    const scope = optionalString(request, "scope");
    const args = ["deploy", "--yes", "--format=json"];
    if (project) args.push("--project", project);
    if (scope) args.push("--scope", scope);
    if (production) args.push("--prod");
    const projectDependency = [...operations]
      .reverse()
      .find(({ capability }) => capability === "project")?.id;
    operations.push(
      operation(request, {
        provider: "vercel",
        capability: "deployment",
        action: production ? "deployment.production" : "deployment.preview",
        title: `Create a ${production ? "production" : "preview"} deployment`,
        identity: { project, scope, production },
        riskClass: production ? "critical" : "high",
        effectClass: "reversible_external",
        reversibility: "conditionally_reversible",
        credentialRef: request.credentialRef,
        dependsOn: projectDependency ? [projectDependency] : [],
        command: { binary: "vercel", args },
        readBack: {
          transport: "cli",
          command: {
            binary: "vercel",
            args: [
              "inspect",
              "{result.url}",
              "--wait",
              "--format=json",
              ...(scope ? ["--scope", scope] : []),
            ],
          },
          description: "Vercel inspection reached a terminal deployment state",
          assertions: [
            { path: "id", operator: "equals", expected: "{result.id}" },
            { path: "readyState", operator: "equals", expected: "READY" },
          ],
        },
        verification: {
          strategy: "response_then_read_back",
          description: "Inspect the returned deployment URL and require a ready state",
        },
      }),
    );
  }
  if (hasCapability(request, "domain")) {
    const domain = inputString(request, "domain");
    const project = inputString(request, "project");
    operations.push(
      operation(request, {
        provider: "vercel",
        capability: "domain",
        action: "domain.add",
        title: `Attach ${domain} to ${project}`,
        identity: { domain, project },
        riskClass: "critical",
        effectClass: "reversible_external",
        reversibility: "conditionally_reversible",
        credentialRef: request.credentialRef,
        command: {
          binary: "vercel",
          args: ["domains", "add", domain, project],
        },
        readBack: {
          transport: "cli",
          command: { binary: "vercel", args: ["domains", "inspect", domain] },
          description: "Vercel returned domain ownership and configuration state",
          assertions: [{ path: "", operator: "contains", expected: domain }],
        },
        verification: {
          strategy: "read_back",
          description: "Inspect the domain and keep DNS configuration pending if needed",
        },
      }),
    );
  }
  if (hasCapability(request, "web_analytics")) {
    const project = inputString(request, "project");
    const scope = optionalString(request, "scope");
    operations.push(
      operation(request, {
        provider: "vercel",
        capability: "web_analytics",
        action: "web_analytics.enable_manual",
        title: `Enable Web Analytics for ${project}`,
        identity: { project, scope },
        riskClass: "medium",
        effectClass: "manual",
        reversibility: "manual",
        manual: {
          system: "Vercel dashboard",
          url: `https://vercel.com/${scope ?? "dashboard"}/${project}/analytics`,
          instructions: [
            `Open Web Analytics for the exact project ${project} in scope ${scope ?? "the reviewed account"}.`,
            "Enable Web Analytics in the dashboard; do not enable a paid Analytics Plus add-on unless separately authorized.",
            "Deploy the repository only after its consent-aware analytics integration has passed local checks.",
            "Visit the verified deployment and confirm the analytics script request succeeds without private form or user-content fields.",
            "Read the project Analytics page back and keep collection readiness distinct from observed traffic data.",
          ],
          requiredFields: { project, ...(scope ? { scope } : {}) },
          completionEvidence: [
            "Vercel project Analytics page showing Web Analytics enabled",
            "Verified deployment URL and successful analytics script request",
            "Consent and analytics-PII quality evidence for the deployed release",
          ],
        },
        verification: {
          strategy: "manual",
          description:
            "Require dashboard and deployed-script read-back; enabling a control is not evidence that traffic was collected",
        },
      }),
    );
  }
  return createPlan("vercel", request, operations, [
    "Deployment and domain readiness require read-back; command acceptance is not success.",
    "Web Analytics enablement stays a declared manual action because the documented setup uses the Vercel dashboard.",
  ]);
}

function neonAuth(request: ProviderPlanRequest) {
  return {
    name: "NEON_API_KEY",
    credentialRef: credentialInput(request),
  };
}

const neonMigrationVersion = "001_core_evidence";
const neonMigrationPath = "migrations/sql/001_core_evidence.up.sql";
const neonManagedTables = [
  "vh_schema_migrations",
  "experiment_events",
  "commercial_events",
  "submissions",
  "consent_events",
  "product_events",
  "provider_webhook_events",
  "analytics_sync_runs",
] as const;
const neonManagedConstraints = [
  "commercial_events_attribution_object",
  "submissions_payload_object",
  "product_events_props_object",
  "provider_webhook_status",
  "analytics_sync_window",
  "analytics_sync_row_count",
  "analytics_sync_quality",
  "analytics_sync_dimensions_array",
  "analytics_sync_limitations_array",
] as const;
const neonSchemaEvidence = [
  `migration:${neonMigrationVersion}`,
  ...neonManagedTables.map((table) => `table:${table}`),
  ...neonManagedConstraints.map((constraint) => `constraint:${constraint}`),
] as const;
const neonSchemaReadBackSql = [
  `select 'migration:' || version from vh_schema_migrations where version = '${neonMigrationVersion}'`,
  `union all select 'table:' || table_name from information_schema.tables where table_schema = 'public' and table_name in (${neonManagedTables.map((table) => `'${table}'`).join(", ")})`,
  `union all select 'constraint:' || conname from pg_constraint where connamespace = 'public'::regnamespace and conname in (${neonManagedConstraints.map((constraint) => `'${constraint}'`).join(", ")});`,
].join(" ");
const neonHealthEvidence = "vh_read_write_ok";
const neonReadWriteHealthSql = [
  "begin;",
  "create temporary table vh_provider_health_check (probe text primary key) on commit drop;",
  `insert into vh_provider_health_check (probe) values ('${neonHealthEvidence}');`,
  `select probe from vh_provider_health_check where probe = '${neonHealthEvidence}';`,
  "rollback;",
].join(" ");

function neonDatabaseAuth(databaseCredentialRef: string) {
  return {
    name: "PGDATABASE",
    credentialRef: databaseCredentialRef,
  };
}

export function buildNeonPlan(request: ProviderPlanRequest): ProviderPlan {
  const operations: ProviderOperation[] = [];
  if (hasCapability(request, "project")) {
    const name = inputString(request, "projectName");
    const region = inputString(request, "regionId");
    const databaseCredentialRef = request.inputs.databaseCredentialRef
      ? credentialInput(request, "databaseCredentialRef")
      : undefined;
    operations.push(
      operation(request, {
        provider: "neon",
        capability: "project",
        action: "project.create",
        title: `Create Neon project ${name}`,
        identity: { name, region },
        riskClass: "critical",
        effectClass: "reversible_external",
        reversibility: "conditionally_reversible",
        credentialRef: request.credentialRef,
        command: {
          binary: "neonctl",
          args: ["projects", "create", "--name", name, "--region-id", region, "--output", "json"],
          authEnvironment: neonAuth(request),
          ...(databaseCredentialRef
            ? {
                captureCredential: {
                  credentialRef: databaseCredentialRef,
                  outputPath: "connection_uris.0.connection_uri",
                },
              }
            : {}),
        },
        readBack: {
          transport: "cli",
          command: {
            binary: "neonctl",
            args: ["projects", "get", "{result.project.id}", "--output", "json"],
            authEnvironment: neonAuth(request),
          },
          description: "Neon returned the new project identity and region",
          assertions: [
            { path: "name", operator: "equals", expected: name },
            { path: "region_id", operator: "equals", expected: region },
          ],
        },
        verification: {
          strategy: "response_then_read_back",
          description: "Read the project by returned id and compare name and region",
        },
      }),
    );
  }
  if (hasCapability(request, "branch")) {
    const projectId = inputString(request, "projectId");
    const name = inputString(request, "branchName");
    operations.push(
      operation(request, {
        provider: "neon",
        capability: "branch",
        action: "branch.create",
        title: `Create Neon branch ${name}`,
        identity: { projectId, name },
        riskClass: "high",
        effectClass: "reversible_external",
        reversibility: "reversible",
        credentialRef: request.credentialRef,
        command: {
          binary: "neonctl",
          args: [
            "branches",
            "create",
            "--project-id",
            projectId,
            "--name",
            name,
            "--output",
            "json",
          ],
          authEnvironment: neonAuth(request),
        },
        readBack: {
          transport: "cli",
          command: {
            binary: "neonctl",
            args: [
              "branches",
              "get",
              "{result.branch.id}",
              "--project-id",
              projectId,
              "--output",
              "json",
            ],
            authEnvironment: neonAuth(request),
          },
          description: "Neon returned the branch by id",
          assertions: [{ path: "name", operator: "equals", expected: name }],
        },
        verification: {
          strategy: "response_then_read_back",
          description: "Read the branch and compare its project and name",
        },
      }),
    );
  }
  if (hasCapability(request, "database")) {
    const projectId = inputString(request, "projectId");
    const branchId = inputString(request, "branchId");
    const name = inputString(request, "databaseName");
    operations.push(
      operation(request, {
        provider: "neon",
        capability: "database",
        action: "database.create",
        title: `Create Neon database ${name}`,
        identity: { projectId, branchId, name },
        riskClass: "critical",
        effectClass: "reversible_external",
        reversibility: "conditionally_reversible",
        credentialRef: request.credentialRef,
        command: {
          binary: "neonctl",
          args: [
            "databases",
            "create",
            "--project-id",
            projectId,
            "--branch-id",
            branchId,
            "--name",
            name,
            "--output",
            "json",
          ],
          authEnvironment: neonAuth(request),
        },
        readBack: {
          transport: "cli",
          command: {
            binary: "neonctl",
            args: [
              "databases",
              "list",
              "--project-id",
              projectId,
              "--branch-id",
              branchId,
              "--output",
              "json",
            ],
            authEnvironment: neonAuth(request),
          },
          description: "Neon returned database metadata without a connection string",
          assertions: [{ path: "", operator: "contains", expected: { name } }],
        },
        verification: {
          strategy: "read_back",
          description: "Read database identity by project, branch, and name",
        },
      }),
    );
  }
  if (hasCapability(request, "role")) {
    const projectId = inputString(request, "projectId");
    const branchId = inputString(request, "branchId");
    const name = inputString(request, "roleName");
    operations.push(
      operation(request, {
        provider: "neon",
        capability: "role",
        action: "role.create",
        title: `Create Neon role ${name}`,
        identity: { projectId, branchId, name },
        riskClass: "critical",
        effectClass: "reversible_external",
        reversibility: "conditionally_reversible",
        credentialRef: request.credentialRef,
        command: {
          binary: "neonctl",
          args: [
            "roles",
            "create",
            "--project-id",
            projectId,
            "--branch-id",
            branchId,
            "--name",
            name,
            "--output",
            "json",
          ],
          authEnvironment: neonAuth(request),
        },
        readBack: {
          transport: "cli",
          command: {
            binary: "neonctl",
            args: [
              "roles",
              "list",
              "--project-id",
              projectId,
              "--branch-id",
              branchId,
              "--output",
              "json",
            ],
            authEnvironment: neonAuth(request),
          },
          description: "Neon returned role metadata; password material stays redacted",
          assertions: [{ path: "", operator: "contains", expected: { name } }],
        },
        verification: {
          strategy: "read_back",
          description: "Read role metadata without emitting generated credentials",
        },
      }),
    );
  }
  const databaseOperationId = operations.find(({ capability }) => capability === "database")?.id;
  const projectOperationId = operations.find(({ capability }) => capability === "project")?.id;
  let migrationOperationId: string | undefined;
  if (hasCapability(request, "schema_migration")) {
    const databaseCredentialRef = credentialInput(request, "databaseCredentialRef");
    const schemaMigration = operation(request, {
      provider: "neon",
      capability: "schema_migration",
      action: "schema.migrate",
      title: `Apply database migration ${neonMigrationVersion}`,
      identity: { version: neonMigrationVersion, path: neonMigrationPath },
      riskClass: "critical",
      effectClass: "reversible_external",
      reversibility: "conditionally_reversible",
      credentialRef: databaseCredentialRef,
      dependsOn: databaseOperationId
        ? [databaseOperationId]
        : projectOperationId
          ? [projectOperationId]
          : [],
      command: {
        binary: "psql",
        args: ["--no-psqlrc", "--set=ON_ERROR_STOP=1", "--file", neonMigrationPath],
        authEnvironment: neonDatabaseAuth(databaseCredentialRef),
      },
      readBack: {
        transport: "cli",
        command: {
          binary: "psql",
          args: [
            "--no-psqlrc",
            "--set=ON_ERROR_STOP=1",
            "--tuples-only",
            "--no-align",
            "--command",
            neonSchemaReadBackSql,
          ],
          authEnvironment: neonDatabaseAuth(databaseCredentialRef),
        },
        description:
          "PostgreSQL returned the migration ledger entry, managed tables, and named constraints",
        assertions: neonSchemaEvidence.map((expected) => ({
          path: "",
          operator: "contains" as const,
          expected,
        })),
      },
      verification: {
        strategy: "read_back",
        description:
          "Read back the versioned migration ledger, every managed table, and every named invariant constraint",
      },
    });
    migrationOperationId = schemaMigration.id;
    operations.push(schemaMigration);
  }
  if (hasCapability(request, "read_write_health_check")) {
    const databaseCredentialRef = credentialInput(request, "databaseCredentialRef");
    const dependency = migrationOperationId ?? databaseOperationId ?? projectOperationId;
    operations.push(
      operation(request, {
        provider: "neon",
        capability: "read_write_health_check",
        action: "database.read_write_health_check",
        title: "Verify disposable database read/write access",
        identity: neonHealthEvidence,
        riskClass: "high",
        effectClass: "reversible_external",
        reversibility: "reversible",
        credentialRef: databaseCredentialRef,
        dependsOn: dependency ? [dependency] : [],
        command: {
          binary: "psql",
          args: [
            "--no-psqlrc",
            "--set=ON_ERROR_STOP=1",
            "--tuples-only",
            "--no-align",
            "--command",
            neonReadWriteHealthSql,
          ],
          authEnvironment: neonDatabaseAuth(databaseCredentialRef),
        },
        readBack: {
          transport: "cli",
          command: {
            binary: "psql",
            args: [
              "--no-psqlrc",
              "--set=ON_ERROR_STOP=1",
              "--tuples-only",
              "--no-align",
              "--command",
              neonReadWriteHealthSql,
            ],
            authEnvironment: neonDatabaseAuth(databaseCredentialRef),
          },
          description: "A fresh transactional write/read probe returned the expected sentinel",
          assertions: [{ path: "", operator: "contains", expected: neonHealthEvidence }],
        },
        verification: {
          strategy: "read_back",
          description:
            "Repeat a temporary-table write/read probe and roll it back without retaining probe data",
        },
      }),
    );
  }
  return createPlan("neon", request, operations, [
    "Neon resource provisioning uses only the API-key credential reference.",
    "Database connections are accepted only through inputs.databaseCredentialRef and are injected into psql through PGDATABASE, never argv or plan artifacts.",
    "For project creation, the command transport captures connection_uris[0].connection_uri directly into an already-registered writable databaseCredentialRef and redacts it before returning output.",
    "Generated role passwords in command output are redacted and are not stored as databaseCredentialRef.",
  ]);
}

function stripeAuth(request: ProviderPlanRequest) {
  return { scheme: "basic" as const, credentialRef: credentialInput(request) };
}

export function buildStripePlan(request: ProviderPlanRequest): ProviderPlan {
  const operations: ProviderOperation[] = [];
  let productOperationId: string | undefined;
  if (hasCapability(request, "product")) {
    const name = inputString(request, "productName");
    const description = optionalString(request, "productDescription");
    const body: Record<string, JsonValue> = { name };
    if (description) body.description = description;
    const product = operation(request, {
      provider: "stripe",
      capability: "product",
      action: "product.create",
      title: `Create Stripe product ${name}`,
      identity: name,
      riskClass: "high",
      effectClass: "financial",
      reversibility: "conditionally_reversible",
      credentialRef: request.credentialRef,
      http: {
        method: "POST",
        url: "https://api.stripe.com/v1/products",
        body,
        encoding: "form",
        auth: stripeAuth(request),
        nativeIdempotency: true,
      },
      readBack: {
        transport: "http",
        http: {
          method: "GET",
          url: "https://api.stripe.com/v1/products/{result.id}",
          auth: stripeAuth(request),
        },
        description: "Stripe returned the created product by id",
        assertions: [
          { path: "name", operator: "equals", expected: name },
          { path: "id", operator: "exists" },
        ],
      },
      verification: {
        strategy: "response_then_read_back",
        description: "Compare product name, livemode, and active state",
      },
    });
    productOperationId = product.id;
    operations.push(product);
  }
  if (hasCapability(request, "price")) {
    const productId = inputString(request, "productId");
    const currency = inputString(request, "currency").toLowerCase();
    const unitAmount = inputNumber(request, "unitAmount");
    if (!Number.isInteger(unitAmount) || unitAmount < 0) {
      throw new Error("Stripe unitAmount must be a non-negative integer in minor units");
    }
    const interval = optionalString(request, "recurringInterval");
    const body: Record<string, JsonValue> = {
      product: productId,
      currency,
      unit_amount: unitAmount,
    };
    if (interval) body.recurring = { interval };
    operations.push(
      operation(request, {
        provider: "stripe",
        capability: "price",
        action: "price.create",
        title: `Create ${currency.toUpperCase()} ${unitAmount} Stripe price`,
        identity: { productId, currency, unitAmount, interval },
        riskClass: "critical",
        effectClass: "financial",
        reversibility: "irreversible",
        credentialRef: request.credentialRef,
        dependsOn: productOperationId ? [productOperationId] : [],
        http: {
          method: "POST",
          url: "https://api.stripe.com/v1/prices",
          body,
          encoding: "form",
          auth: stripeAuth(request),
          nativeIdempotency: true,
        },
        readBack: {
          transport: "http",
          http: {
            method: "GET",
            url: "https://api.stripe.com/v1/prices/{result.id}",
            auth: stripeAuth(request),
          },
          description: "Stripe returned the immutable price by id",
          assertions: [
            { path: "product", operator: "equals", expected: productId },
            { path: "currency", operator: "equals", expected: currency },
            { path: "unit_amount", operator: "equals", expected: unitAmount },
          ],
        },
        verification: {
          strategy: "response_then_read_back",
          description: "Compare exact minor-unit amount, currency, product, and interval",
        },
      }),
    );
  }
  if (hasCapability(request, "webhook")) {
    const url = inputString(request, "webhookUrl");
    const enabledEvents = inputStrings(request, "enabledEvents");
    operations.push(
      operation(request, {
        provider: "stripe",
        capability: "webhook",
        action: "webhook_endpoint.create",
        title: `Create Stripe webhook endpoint ${url}`,
        identity: { url, enabledEvents: [...enabledEvents].sort() },
        riskClass: "critical",
        effectClass: "communication",
        reversibility: "reversible",
        credentialRef: request.credentialRef,
        http: {
          method: "POST",
          url: "https://api.stripe.com/v1/webhook_endpoints",
          body: { url, enabled_events: enabledEvents },
          encoding: "form",
          auth: stripeAuth(request),
          nativeIdempotency: true,
        },
        readBack: {
          transport: "http",
          http: {
            method: "GET",
            url: "https://api.stripe.com/v1/webhook_endpoints/{result.id}",
            auth: stripeAuth(request),
          },
          description: "Stripe returned the webhook endpoint metadata",
          assertions: [
            { path: "url", operator: "equals", expected: url },
            {
              path: "enabled_events",
              operator: "contains",
              expected: enabledEvents,
            },
          ],
        },
        verification: {
          strategy: "response_then_read_back",
          description: "Compare URL, status, livemode, and enabled events; redact secret",
        },
      }),
    );
  }
  if (hasCapability(request, "billing_portal")) {
    const headline = optionalString(request, "headline");
    const body: Record<string, JsonValue> = {};
    if (headline) body.business_profile = { headline };
    operations.push(
      operation(request, {
        provider: "stripe",
        capability: "billing_portal",
        action: "billing_portal.configuration.create",
        title: "Create Stripe billing portal configuration",
        identity: body,
        riskClass: "high",
        effectClass: "financial",
        reversibility: "conditionally_reversible",
        credentialRef: request.credentialRef,
        http: {
          method: "POST",
          url: "https://api.stripe.com/v1/billing_portal/configurations",
          body,
          encoding: "form",
          auth: stripeAuth(request),
          nativeIdempotency: true,
        },
        readBack: {
          transport: "http",
          http: {
            method: "GET",
            url: "https://api.stripe.com/v1/billing_portal/configurations/{result.id}",
            auth: stripeAuth(request),
          },
          description: "Stripe returned the portal configuration by id",
          assertions: headline
            ? [
                {
                  path: "business_profile.headline",
                  operator: "equals",
                  expected: headline,
                },
              ]
            : [{ path: "id", operator: "exists" }],
        },
        verification: {
          strategy: "response_then_read_back",
          description: "Compare portal configuration and active/default status",
        },
      }),
    );
  }
  return createPlan("stripe", request, operations, [
    "Prices cannot be corrected in place; create a new price when exact values differ.",
  ]);
}

function revenueCatAuth(request: ProviderPlanRequest) {
  return { scheme: "bearer" as const, credentialRef: credentialInput(request) };
}

export function buildRevenueCatPlan(request: ProviderPlanRequest): ProviderPlan {
  const operations: ProviderOperation[] = [];
  if (hasCapability(request, "project_bootstrap")) {
    const projectName = inputString(request, "projectName");
    operations.push(
      operation(request, {
        provider: "revenuecat",
        capability: "project_bootstrap",
        action: "project.bootstrap_manual",
        title: `Create RevenueCat project ${projectName} and restricted key`,
        identity: projectName,
        riskClass: "critical",
        effectClass: "manual",
        reversibility: "manual",
        manual: {
          system: "RevenueCat dashboard",
          url: "https://app.revenuecat.com/",
          instructions: [
            "Create the project in the RevenueCat dashboard.",
            "Create a secret v2 API key with only the configuration permissions required by this plan.",
            "Store the key in a credential backend and record only its cred:// reference.",
            "Record the returned project id for subsequent API operations.",
          ],
          requiredFields: { projectName },
          completionEvidence: [
            "RevenueCat project id",
            "Credential reference (never the key value)",
            "Declared key permissions",
          ],
        },
        verification: {
          strategy: "manual",
          description: "A human records the project id and tested credential reference",
        },
      }),
    );
  }
  if (hasCapability(request, "app")) {
    const projectId = inputString(request, "projectId");
    const name = inputString(request, "appName");
    const type = inputString(request, "appType");
    const bundleId = inputString(request, "bundleId");
    operations.push(
      operation(request, {
        provider: "revenuecat",
        capability: "app",
        action: "app.create",
        title: `Create RevenueCat app ${name}`,
        identity: { projectId, name, type, bundleId },
        riskClass: "critical",
        effectClass: "financial",
        reversibility: "conditionally_reversible",
        credentialRef: request.credentialRef,
        http: {
          method: "POST",
          url: `https://api.revenuecat.com/v2/projects/${encoded(projectId)}/apps`,
          body: { name, type, app_store: { bundle_id: bundleId } },
          auth: revenueCatAuth(request),
        },
        readBack: {
          transport: "http",
          http: {
            method: "GET",
            url: `https://api.revenuecat.com/v2/projects/${encoded(projectId)}/apps/{result.id}`,
            auth: revenueCatAuth(request),
          },
          description: "RevenueCat returned the app by project and id",
          assertions: [
            { path: "name", operator: "equals", expected: name },
            { path: "type", operator: "equals", expected: type },
            {
              path: "app_store.bundle_id",
              operator: "equals",
              expected: bundleId,
            },
          ],
        },
        verification: {
          strategy: "response_then_read_back",
          description: "Compare app name, platform type, and bundle identifier",
        },
      }),
    );
  }
  if (hasCapability(request, "entitlement")) {
    const projectId = inputString(request, "projectId");
    const lookupKey = inputString(request, "entitlementLookupKey");
    const displayName = inputString(request, "entitlementDisplayName");
    operations.push(
      operation(request, {
        provider: "revenuecat",
        capability: "entitlement",
        action: "entitlement.create",
        title: `Create RevenueCat entitlement ${lookupKey}`,
        identity: { projectId, lookupKey },
        riskClass: "critical",
        effectClass: "financial",
        reversibility: "conditionally_reversible",
        credentialRef: request.credentialRef,
        http: {
          method: "POST",
          url: `https://api.revenuecat.com/v2/projects/${encoded(projectId)}/entitlements`,
          body: { lookup_key: lookupKey, display_name: displayName },
          auth: revenueCatAuth(request),
        },
        readBack: {
          transport: "http",
          http: {
            method: "GET",
            url: `https://api.revenuecat.com/v2/projects/${encoded(projectId)}/entitlements/{result.id}`,
            auth: revenueCatAuth(request),
          },
          description: "RevenueCat returned the entitlement by id",
          assertions: [
            { path: "lookup_key", operator: "equals", expected: lookupKey },
            { path: "display_name", operator: "equals", expected: displayName },
          ],
        },
        verification: {
          strategy: "response_then_read_back",
          description: "Compare lookup key and display name",
        },
      }),
    );
  }
  if (hasCapability(request, "offering")) {
    const projectId = inputString(request, "projectId");
    const lookupKey = inputString(request, "offeringLookupKey");
    const displayName = inputString(request, "offeringDisplayName");
    operations.push(
      operation(request, {
        provider: "revenuecat",
        capability: "offering",
        action: "offering.create",
        title: `Create RevenueCat offering ${lookupKey}`,
        identity: { projectId, lookupKey },
        riskClass: "critical",
        effectClass: "financial",
        reversibility: "conditionally_reversible",
        credentialRef: request.credentialRef,
        http: {
          method: "POST",
          url: `https://api.revenuecat.com/v2/projects/${encoded(projectId)}/offerings`,
          body: { lookup_key: lookupKey, display_name: displayName },
          auth: revenueCatAuth(request),
        },
        readBack: {
          transport: "http",
          http: {
            method: "GET",
            url: `https://api.revenuecat.com/v2/projects/${encoded(projectId)}/offerings/{result.id}`,
            auth: revenueCatAuth(request),
          },
          description: "RevenueCat returned the offering by id",
          assertions: [
            { path: "lookup_key", operator: "equals", expected: lookupKey },
            { path: "display_name", operator: "equals", expected: displayName },
          ],
        },
        verification: {
          strategy: "response_then_read_back",
          description: "Compare offering lookup key, display name, and current state",
        },
      }),
    );
  }
  if (hasCapability(request, "webhook")) {
    const projectId = inputString(request, "projectId");
    const name = inputString(request, "webhookName");
    const url = inputString(request, "webhookUrl");
    operations.push(
      operation(request, {
        provider: "revenuecat",
        capability: "webhook",
        action: "webhook.create",
        title: `Create RevenueCat webhook ${name}`,
        identity: { projectId, name, url },
        riskClass: "critical",
        effectClass: "communication",
        reversibility: "reversible",
        credentialRef: request.credentialRef,
        http: {
          method: "POST",
          url: `https://api.revenuecat.com/v2/projects/${encoded(projectId)}/integrations/webhooks`,
          body: { name, url },
          auth: revenueCatAuth(request),
        },
        readBack: {
          transport: "http",
          http: {
            method: "GET",
            url: `https://api.revenuecat.com/v2/projects/${encoded(projectId)}/integrations/webhooks/{result.id}`,
            auth: revenueCatAuth(request),
          },
          description: "RevenueCat returned webhook metadata by id",
          assertions: [
            { path: "name", operator: "equals", expected: name },
            { path: "url", operator: "equals", expected: url },
          ],
        },
        verification: {
          strategy: "response_then_read_back",
          description: "Compare webhook name, URL, and active state",
        },
      }),
    );
  }
  return createPlan("revenuecat", request, operations, [
    "Project and secret-key creation are dashboard-only prerequisites.",
  ]);
}

function brevoAuth(request: ProviderPlanRequest) {
  return {
    scheme: "api_key_header" as const,
    credentialRef: credentialInput(request),
    name: "api-key",
  };
}

export function buildBrevoPlan(request: ProviderPlanRequest): ProviderPlan {
  const operations: ProviderOperation[] = [];
  if (hasCapability(request, "sending_domain")) {
    const domainName = inputString(request, "domainName");
    operations.push(
      operation(request, {
        provider: "brevo",
        capability: "sending_domain",
        action: "sending_domain.create",
        title: `Add Brevo sending domain ${domainName}`,
        identity: domainName,
        riskClass: "high",
        effectClass: "communication",
        reversibility: "reversible",
        credentialRef: request.credentialRef,
        http: {
          method: "POST",
          url: "https://api.brevo.com/v3/senders/domains",
          body: { name: domainName },
          auth: brevoAuth(request),
        },
        readBack: {
          transport: "http",
          http: {
            method: "GET",
            url: "https://api.brevo.com/v3/senders/domains",
            auth: brevoAuth(request),
          },
          description: "Brevo returned the domain and authentication state",
          assertions: [
            {
              path: "domains",
              operator: "contains",
              expected: { domain_name: domainName },
            },
          ],
        },
        verification: {
          strategy: "response_then_read_back",
          description: "Require authenticated DNS state before treating sending as ready",
        },
      }),
    );
  }
  if (hasCapability(request, "sending_domain_verification")) {
    const domainName = inputString(request, "domainName");
    operations.push(
      operation(request, {
        provider: "brevo",
        capability: "sending_domain_verification",
        action: "sending_domain.authenticate",
        title: `Authenticate Brevo sending domain ${domainName}`,
        identity: domainName,
        riskClass: "high",
        effectClass: "communication",
        reversibility: "reversible",
        credentialRef: request.credentialRef,
        http: {
          method: "PUT",
          url: `https://api.brevo.com/v3/senders/domains/${encoded(domainName)}/authenticate`,
          auth: brevoAuth(request),
        },
        readBack: {
          transport: "http",
          http: {
            method: "GET",
            url: `https://api.brevo.com/v3/senders/domains/${encoded(domainName)}`,
            auth: brevoAuth(request),
          },
          description: "Brevo returned a verified and authenticated domain configuration",
          assertions: [
            { path: "domain", operator: "equals", expected: domainName },
            { path: "verified", operator: "equals", expected: true },
            { path: "authenticated", operator: "equals", expected: true },
          ],
        },
        verification: {
          strategy: "response_then_read_back",
          description: "Require verified=true and authenticated=true after the DNS checkpoint",
        },
      }),
    );
  }
  if (hasCapability(request, "sender")) {
    const name = inputString(request, "senderName");
    const email = inputString(request, "senderEmail");
    operations.push(
      operation(request, {
        provider: "brevo",
        capability: "sender",
        action: "sender.create",
        title: `Create Brevo sender ${name}`,
        identity: { name, email },
        riskClass: "high",
        effectClass: "communication",
        reversibility: "reversible",
        credentialRef: request.credentialRef,
        http: {
          method: "POST",
          url: "https://api.brevo.com/v3/senders",
          body: { name, email },
          auth: brevoAuth(request),
        },
        readBack: {
          transport: "http",
          http: {
            method: "GET",
            url: "https://api.brevo.com/v3/senders",
            auth: brevoAuth(request),
          },
          description: "Brevo sender list contains the requested sender",
          assertions: [
            {
              path: "senders",
              operator: "contains",
              expected: { name, email },
            },
          ],
        },
        verification: {
          strategy: "response_then_read_back",
          description: "Compare sender name, address, and active state",
        },
      }),
    );
  }
  if (hasCapability(request, "template")) {
    const name = inputString(request, "templateName");
    const subject = inputString(request, "templateSubject");
    const htmlContent = inputString(request, "templateHtml");
    operations.push(
      operation(request, {
        provider: "brevo",
        capability: "template",
        action: "template.create",
        title: `Create Brevo template ${name}`,
        identity: { name, subject, contentHash: htmlContent.length },
        riskClass: "high",
        effectClass: "communication",
        reversibility: "reversible",
        credentialRef: request.credentialRef,
        http: {
          method: "POST",
          url: "https://api.brevo.com/v3/smtp/templates",
          body: { name, subject, htmlContent, isActive: false },
          auth: brevoAuth(request),
        },
        readBack: {
          transport: "http",
          http: {
            method: "GET",
            url: "https://api.brevo.com/v3/smtp/templates/{result.id}",
            auth: brevoAuth(request),
          },
          description: "Brevo returned the inactive template by id",
          assertions: [
            { path: "name", operator: "equals", expected: name },
            { path: "subject", operator: "equals", expected: subject },
            { path: "isActive", operator: "equals", expected: false },
          ],
        },
        verification: {
          strategy: "response_then_read_back",
          description: "Compare template name and subject; keep it inactive until review",
        },
      }),
    );
  }
  if (hasCapability(request, "webhook")) {
    const url = inputString(request, "webhookUrl");
    const events = inputStrings(request, "webhookEvents");
    operations.push(
      operation(request, {
        provider: "brevo",
        capability: "webhook",
        action: "webhook.create",
        title: `Create Brevo webhook ${url}`,
        identity: { url, events: [...events].sort() },
        riskClass: "critical",
        effectClass: "communication",
        reversibility: "reversible",
        credentialRef: request.credentialRef,
        http: {
          method: "POST",
          url: "https://api.brevo.com/v3/webhooks",
          body: { url, events, type: "transactional" },
          auth: brevoAuth(request),
        },
        readBack: {
          transport: "http",
          http: {
            method: "GET",
            url: "https://api.brevo.com/v3/webhooks/{result.id}",
            auth: brevoAuth(request),
          },
          description: "Brevo returned the webhook by id",
          assertions: [
            { path: "url", operator: "equals", expected: url },
            { path: "events", operator: "contains", expected: events },
          ],
        },
        verification: {
          strategy: "response_then_read_back",
          description: "Compare endpoint URL, type, and event set",
        },
      }),
    );
  }
  return createPlan("brevo", request, operations, [
    "Domain setup remains pending until DNS authentication reads back as valid.",
  ]);
}

function googleAuth(request: ProviderPlanRequest) {
  return { scheme: "bearer" as const, credentialRef: credentialInput(request) };
}

export function buildGooglePlan(request: ProviderPlanRequest): ProviderPlan {
  const operations: ProviderOperation[] = [];
  if (hasCapability(request, "analytics_property")) {
    const accountId = inputString(request, "analyticsAccountId");
    const displayName = inputString(request, "propertyDisplayName");
    const timeZone = inputString(request, "reportingTimeZone");
    const currencyCode = inputString(request, "currencyCode");
    operations.push(
      operation(request, {
        provider: "google",
        capability: "analytics_property",
        action: "analytics_property.create",
        title: `Create Google Analytics property ${displayName}`,
        identity: { accountId, displayName },
        riskClass: "high",
        effectClass: "reversible_external",
        reversibility: "conditionally_reversible",
        credentialRef: request.credentialRef,
        http: {
          method: "POST",
          url: `https://analyticsadmin.googleapis.com/v1beta/properties?parent=accounts/${encoded(accountId)}`,
          body: { displayName, timeZone, currencyCode },
          auth: googleAuth(request),
        },
        readBack: {
          transport: "http",
          http: {
            method: "GET",
            url: "https://analyticsadmin.googleapis.com/v1beta/{result.name}",
            auth: googleAuth(request),
          },
          description: "Google Analytics returned the property resource",
          assertions: [
            { path: "displayName", operator: "equals", expected: displayName },
            { path: "timeZone", operator: "equals", expected: timeZone },
            { path: "currencyCode", operator: "equals", expected: currencyCode },
          ],
        },
        verification: {
          strategy: "response_then_read_back",
          description: "Compare display name, time zone, currency, and account parent",
        },
      }),
    );
  }
  if (hasCapability(request, "analytics_web_stream")) {
    const propertyId = inputString(request, "analyticsPropertyId");
    const displayName = inputString(request, "streamDisplayName");
    const defaultUri = inputString(request, "defaultUri");
    operations.push(
      operation(request, {
        provider: "google",
        capability: "analytics_web_stream",
        action: "analytics_web_stream.create",
        title: `Create Analytics web stream ${displayName}`,
        identity: { propertyId, defaultUri },
        riskClass: "high",
        effectClass: "reversible_external",
        reversibility: "conditionally_reversible",
        credentialRef: request.credentialRef,
        http: {
          method: "POST",
          url: `https://analyticsadmin.googleapis.com/v1beta/properties/${encoded(propertyId)}/dataStreams`,
          body: {
            type: "WEB_DATA_STREAM",
            displayName,
            webStreamData: { defaultUri },
          },
          auth: googleAuth(request),
        },
        readBack: {
          transport: "http",
          http: {
            method: "GET",
            url: "https://analyticsadmin.googleapis.com/v1beta/{result.name}",
            auth: googleAuth(request),
          },
          description: "Google Analytics returned the web data stream",
          assertions: [
            { path: "displayName", operator: "equals", expected: displayName },
            {
              path: "webStreamData.defaultUri",
              operator: "equals",
              expected: defaultUri,
            },
            { path: "webStreamData.measurementId", operator: "exists" },
          ],
        },
        verification: {
          strategy: "response_then_read_back",
          description: "Compare property, URI, display name, and measurement id",
        },
      }),
    );
  }
  if (hasCapability(request, "site_verification_token")) {
    const identifier = inputString(request, "siteIdentifier");
    const siteType = optionalString(request, "siteType") ?? "INET_DOMAIN";
    const method = optionalString(request, "verificationMethod") ?? "DNS_TXT";
    operations.push(
      operation(request, {
        provider: "google",
        capability: "site_verification_token",
        action: "site_verification.token.get",
        title: `Request Google verification token for ${identifier}`,
        identity: { identifier, siteType, method },
        riskClass: "medium",
        effectClass: "read",
        reversibility: "reversible",
        credentialRef: request.credentialRef,
        http: {
          method: "POST",
          url: "https://www.googleapis.com/siteVerification/v1/token",
          body: {
            site: { identifier, type: siteType },
            verificationMethod: method,
          },
          auth: googleAuth(request),
        },
        readBack: {
          transport: "http",
          http: {
            method: "POST",
            url: "https://www.googleapis.com/siteVerification/v1/token",
            body: {
              site: { identifier, type: siteType },
              verificationMethod: method,
            },
            auth: googleAuth(request),
          },
          description:
            "Google returned the same DNS verification token for the same site and method",
          assertions: [
            { path: "method", operator: "equals", expected: method },
            { path: "token", operator: "equals", expected: "{result.token}" },
          ],
        },
        verification: {
          strategy: "response_then_read_back",
          description: "Treat the token as pending until it is published and verified",
        },
      }),
    );
  }
  if (hasCapability(request, "site_verification")) {
    const identifier = inputString(request, "siteIdentifier");
    const siteType = optionalString(request, "siteType") ?? "INET_DOMAIN";
    const method = optionalString(request, "verificationMethod") ?? "DNS_TXT";
    operations.push(
      operation(request, {
        provider: "google",
        capability: "site_verification",
        action: "site_verification.web_resource.insert",
        title: `Verify Google ownership of ${identifier}`,
        identity: { identifier, siteType, method },
        riskClass: "high",
        effectClass: "reversible_external",
        reversibility: "reversible",
        credentialRef: request.credentialRef,
        http: {
          method: "POST",
          url: `https://www.googleapis.com/siteVerification/v1/webResource?verificationMethod=${encoded(method)}`,
          body: { site: { identifier, type: siteType } },
          auth: googleAuth(request),
        },
        readBack: {
          transport: "http",
          http: {
            method: "GET",
            url: "https://www.googleapis.com/siteVerification/v1/webResource",
            auth: googleAuth(request),
          },
          description: "Google Site Verification returned the owned domain",
          assertions: [
            {
              path: "items",
              operator: "contains",
              expected: { site: { identifier, type: siteType } },
            },
          ],
        },
        verification: {
          strategy: "response_then_read_back",
          description: "Require the exact domain in the authenticated user's verified resources",
        },
      }),
    );
  }
  if (hasCapability(request, "search_console_site")) {
    const siteUrl = inputString(request, "siteUrl");
    operations.push(
      operation(request, {
        provider: "google",
        capability: "search_console_site",
        action: "search_console.site.add",
        title: `Add ${siteUrl} to Search Console`,
        identity: siteUrl,
        riskClass: "high",
        effectClass: "reversible_external",
        reversibility: "reversible",
        credentialRef: request.credentialRef,
        http: {
          method: "PUT",
          url: `https://searchconsole.googleapis.com/webmasters/v3/sites/${encoded(siteUrl)}`,
          auth: googleAuth(request),
        },
        readBack: {
          transport: "http",
          http: {
            method: "GET",
            url: "https://searchconsole.googleapis.com/webmasters/v3/sites",
            auth: googleAuth(request),
          },
          description: "Search Console site list contains the requested property",
          assertions: [
            {
              path: "siteEntry",
              operator: "contains",
              expected: { siteUrl },
            },
          ],
        },
        verification: {
          strategy: "read_back",
          description: "Require the expected permission level in the site list",
        },
      }),
    );
  }
  if (hasCapability(request, "search_console_sitemap")) {
    const siteUrl = inputString(request, "siteUrl");
    const sitemapUrl = inputString(request, "sitemapUrl");
    operations.push(
      operation(request, {
        provider: "google",
        capability: "search_console_sitemap",
        action: "search_console.sitemap.submit",
        title: `Submit sitemap ${sitemapUrl}`,
        identity: { siteUrl, sitemapUrl },
        riskClass: "medium",
        effectClass: "reversible_external",
        reversibility: "reversible",
        credentialRef: request.credentialRef,
        http: {
          method: "PUT",
          url: `https://searchconsole.googleapis.com/webmasters/v3/sites/${encoded(siteUrl)}/sitemaps/${encoded(sitemapUrl)}`,
          auth: googleAuth(request),
        },
        readBack: {
          transport: "http",
          http: {
            method: "GET",
            url: `https://searchconsole.googleapis.com/webmasters/v3/sites/${encoded(siteUrl)}/sitemaps/${encoded(sitemapUrl)}`,
            auth: googleAuth(request),
          },
          description: "Search Console returned the submitted sitemap state",
          assertions: [{ path: "path", operator: "equals", expected: sitemapUrl }],
        },
        verification: {
          strategy: "read_back",
          description: "Record submission state and errors; never infer indexing",
        },
      }),
    );
  }
  return createPlan("google", request, operations, [
    "Search and Analytics data can lag; resource existence is distinct from data availability.",
  ]);
}

function bingAuth(request: ProviderPlanRequest) {
  const mode = optionalString(request, "authMode") ?? "api_key";
  if (mode === "oauth") {
    return { scheme: "bearer" as const, credentialRef: credentialInput(request) };
  }
  return {
    scheme: "api_key_query" as const,
    credentialRef: credentialInput(request),
    name: "apikey",
  };
}

const bingBase = "https://ssl.bing.com/webmaster/api.svc/json";

export function buildBingPlan(request: ProviderPlanRequest): ProviderPlan {
  const operations: ProviderOperation[] = [];
  if (hasCapability(request, "site")) {
    const siteUrl = inputString(request, "siteUrl");
    operations.push(
      operation(request, {
        provider: "bing",
        capability: "site",
        action: "site.add",
        title: `Add ${siteUrl} to Bing Webmaster Tools`,
        identity: siteUrl,
        riskClass: "medium",
        effectClass: "reversible_external",
        reversibility: "reversible",
        credentialRef: request.credentialRef,
        http: {
          method: "POST",
          url: `${bingBase}/AddSite`,
          body: { siteUrl },
          auth: bingAuth(request),
        },
        readBack: {
          transport: "http",
          http: {
            method: "GET",
            url: `${bingBase}/GetUserSites`,
            auth: bingAuth(request),
          },
          description: "Bing site list contains the requested site URL",
          assertions: [{ path: "d", operator: "contains", expected: { Url: siteUrl } }],
        },
        verification: {
          strategy: "read_back",
          description: "Read the site list and keep ownership verification distinct",
        },
      }),
    );
  }
  if (hasCapability(request, "sitemap")) {
    const siteUrl = inputString(request, "siteUrl");
    const sitemapUrl = inputString(request, "sitemapUrl");
    operations.push(
      operation(request, {
        provider: "bing",
        capability: "sitemap",
        action: "feed.add",
        title: `Submit ${sitemapUrl} to Bing`,
        identity: { siteUrl, sitemapUrl },
        riskClass: "medium",
        effectClass: "reversible_external",
        reversibility: "reversible",
        credentialRef: request.credentialRef,
        http: {
          method: "POST",
          url: `${bingBase}/SubmitFeed`,
          body: { siteUrl, feedUrl: sitemapUrl },
          auth: bingAuth(request),
        },
        readBack: {
          transport: "http",
          http: {
            method: "GET",
            url: `${bingBase}/GetFeeds?siteUrl=${encoded(siteUrl)}`,
            auth: bingAuth(request),
          },
          description: "Bing feed list contains the submitted sitemap",
          assertions: [{ path: "d", operator: "contains", expected: { Url: sitemapUrl } }],
        },
        verification: {
          strategy: "read_back",
          description: "Read feed state and errors; request acceptance is not indexing",
        },
      }),
    );
  }
  if (hasCapability(request, "url_submission")) {
    const siteUrl = inputString(request, "siteUrl");
    const url = inputString(request, "submissionUrl");
    operations.push(
      operation(request, {
        provider: "bing",
        capability: "url_submission",
        action: "url.submit",
        title: `Submit ${url} to Bing`,
        identity: { siteUrl, url },
        riskClass: "medium",
        effectClass: "reversible_external",
        reversibility: "conditionally_reversible",
        credentialRef: request.credentialRef,
        http: {
          method: "POST",
          url: `${bingBase}/SubmitUrl`,
          body: { siteUrl, url },
          auth: bingAuth(request),
        },
        verification: {
          strategy: "response_then_read_back",
          description: "Record only API acceptance; indexing remains unknown",
        },
      }),
    );
  }
  return createPlan("bing", request, operations, [
    "The legacy Webmaster API may be unavailable; run doctor before any request.",
  ]);
}

function buildManualDnsPlan(
  provider: "dns" | "mijndomein",
  request: ProviderPlanRequest,
): ProviderPlan {
  const operations: ProviderOperation[] = [];
  if (hasCapability(request, "record")) {
    const zone = inputString(request, "zone");
    const recordType = inputString(request, "recordType").toUpperCase();
    const recordName = inputString(request, "recordName");
    const recordValue = inputString(request, "recordValue");
    const ttl = optionalNumber(request, "ttl") ?? 3_600;
    operations.push(
      operation(request, {
        provider,
        capability: "record",
        action: "dns_record.change_manual",
        title: `Set ${recordType} ${recordName} in ${zone}`,
        identity: { zone, recordType, recordName, recordValue, ttl },
        riskClass: "critical",
        effectClass: "manual",
        reversibility: "manual",
        manual: {
          system: provider === "mijndomein" ? "MijnDomein control panel" : "DNS control panel",
          url: provider === "mijndomein" ? "https://mijn.mijndomein.nl/" : undefined,
          instructions: [
            `Open the authoritative DNS zone for ${zone}.`,
            `Check for an existing ${recordType} record named ${recordName}; do not create a duplicate.`,
            `Set the value exactly to ${recordValue} with TTL ${ttl}.`,
            "Save the change, then query the authoritative nameservers until the exact record reads back.",
          ],
          requiredFields: {
            zone,
            recordType,
            recordName,
            recordValue,
            ttl,
          },
          completionEvidence: [
            "Control-panel change receipt or screenshot",
            "Authoritative DNS response with exact name, type, value, and TTL",
          ],
        },
        verification: {
          strategy: "manual",
          description: "Require authoritative DNS read-back; propagation alone is not proof",
        },
      }),
    );
  }
  if (provider === "mijndomein" && hasCapability(request, "domain_attachment")) {
    const domain = inputString(request, "domain");
    const target = inputString(request, "targetService");
    operations.push(
      operation(request, {
        provider,
        capability: "domain_attachment",
        action: "domain.attach_manual",
        title: `Attach ${domain} to ${target}`,
        identity: { domain, target },
        riskClass: "critical",
        effectClass: "manual",
        reversibility: "manual",
        manual: {
          system: "MijnDomein control panel",
          url: "https://mijn.mijndomein.nl/",
          instructions: [
            `Inspect all existing records for ${domain} before changing anything.`,
            `Use the exact DNS records supplied by ${target}; do not infer addresses or verification values.`,
            "Preserve unrelated mail and verification records.",
            "Verify the target service and authoritative DNS after saving.",
          ],
          requiredFields: { domain, targetService: target },
          completionEvidence: [
            "Before-and-after DNS record list",
            "Authoritative DNS response",
            `${target} domain verification state`,
          ],
        },
        verification: {
          strategy: "manual",
          description: "Require both authoritative DNS and target-provider verification",
        },
      }),
    );
  }
  return createPlan(provider, request, operations, [
    "No undocumented DNS write API is called; a human owns each control-panel change.",
  ]);
}

export function buildDnsPlan(request: ProviderPlanRequest): ProviderPlan {
  return buildManualDnsPlan("dns", request);
}

export function buildMijnDomeinPlan(request: ProviderPlanRequest): ProviderPlan {
  return buildManualDnsPlan("mijndomein", request);
}

function appStoreAuth(request: ProviderPlanRequest) {
  return { scheme: "jwt" as const, credentialRef: credentialInput(request) };
}

export function buildAppStoreConnectPlan(request: ProviderPlanRequest): ProviderPlan {
  const operations: ProviderOperation[] = [];
  let buildProcessingOperationId: string | undefined;
  let testflightGroupOperationId: string | undefined;
  if (hasCapability(request, "first_app_record")) {
    const name = inputString(request, "appName");
    const bundleId = inputString(request, "bundleId");
    const sku = inputString(request, "sku");
    const primaryLanguage = optionalString(request, "primaryLanguage") ?? "en-US";
    operations.push(
      operation(request, {
        provider: "app_store_connect",
        capability: "first_app_record",
        action: "app_record.create_manual",
        title: `Create first App Store Connect record for ${name}`,
        identity: { name, bundleId, sku },
        riskClass: "critical",
        effectClass: "manual",
        reversibility: "manual",
        manual: {
          system: "App Store Connect web interface",
          url: "https://appstoreconnect.apple.com/apps",
          instructions: [
            "Open My Apps and choose New App.",
            `Select the registered bundle identifier ${bundleId}.`,
            `Enter name ${name}, SKU ${sku}, and primary language ${primaryLanguage}.`,
            "Create the record and copy the numeric Apple app id.",
            "Do not claim the app is submitted or approved; this step creates only the record.",
          ],
          requiredFields: { name, bundleId, sku, primaryLanguage },
          completionEvidence: [
            "Numeric App Store Connect app id",
            "Bundle identifier shown on the app record",
            "App record URL",
          ],
        },
        verification: {
          strategy: "manual",
          description: "A human records the app id and verifies the exact bundle identifier",
        },
      }),
    );
  }
  if (hasCapability(request, "build_processing")) {
    const appId = inputString(request, "appStoreAppId");
    const appVersion = inputString(request, "appVersion");
    const buildNumber = inputString(request, "buildNumber");
    const query = [
      `filter[app]=${encoded(appId)}`,
      `filter[preReleaseVersion.version]=${encoded(appVersion)}`,
      `filter[version]=${encoded(buildNumber)}`,
      "filter[processingState]=VALID",
      "include=betaGroups",
      "limit=2",
    ].join("&");
    const build = operation(request, {
      provider: "app_store_connect",
      capability: "build_processing",
      action: "processing.status.get",
      title: `Read TestFlight processing for ${appVersion} (${buildNumber})`,
      identity: { appId, appVersion, buildNumber },
      riskClass: "medium",
      effectClass: "read",
      reversibility: "reversible",
      credentialRef: request.credentialRef,
      http: {
        method: "GET",
        url: `https://api.appstoreconnect.apple.com/v1/builds?${query}`,
        auth: appStoreAuth(request),
      },
      readBack: {
        transport: "http",
        http: {
          method: "GET",
          url: `https://api.appstoreconnect.apple.com/v1/builds?${query}`,
          auth: appStoreAuth(request),
        },
        description: "App Store Connect returned one exact VALID processed build",
        assertions: [
          {
            path: "data",
            operator: "contains",
            expected: {
              type: "builds",
              attributes: { version: buildNumber, processingState: "VALID" },
            },
          },
        ],
      },
      verification: {
        strategy: "read_back",
        description:
          "Require the exact app, marketing version, build number, and VALID processing state; do not infer publication",
      },
    });
    buildProcessingOperationId = build.id;
    operations.push(build);
  }
  if (hasCapability(request, "testflight_group")) {
    const appId = inputString(request, "appStoreAppId");
    const name = inputString(request, "betaGroupName");
    const isInternalGroup = inputBoolean(request, "isInternalGroup", true);
    const group = operation(request, {
      provider: "app_store_connect",
      capability: "testflight_group",
      action: "testflight_group.create",
      title: `Create TestFlight group ${name}`,
      identity: { appId, name, isInternalGroup },
      riskClass: "high",
      effectClass: "reversible_external",
      reversibility: "reversible",
      credentialRef: request.credentialRef,
      dependsOn: buildProcessingOperationId ? [buildProcessingOperationId] : [],
      http: {
        method: "POST",
        url: "https://api.appstoreconnect.apple.com/v1/betaGroups",
        body: {
          data: {
            type: "betaGroups",
            attributes: { name, isInternalGroup },
            relationships: {
              app: { data: { type: "apps", id: appId } },
            },
          },
        },
        auth: appStoreAuth(request),
      },
      readBack: {
        transport: "http",
        http: {
          method: "GET",
          url: "https://api.appstoreconnect.apple.com/v1/betaGroups/{result.data.id}",
          auth: appStoreAuth(request),
        },
        description: "App Store Connect returned the TestFlight group by id",
        assertions: [
          { path: "data.attributes.name", operator: "equals", expected: name },
          {
            path: "data.attributes.isInternalGroup",
            operator: "equals",
            expected: isInternalGroup,
          },
        ],
      },
      verification: {
        strategy: "response_then_read_back",
        description: "Compare group name, internal flag, and related app id",
      },
    });
    testflightGroupOperationId = group.id;
    operations.push(group);
  }
  if (hasCapability(request, "build_group_assignment")) {
    const buildId = inputString(request, "appStoreBuildId");
    const groupId = inputString(request, "betaGroupId");
    operations.push(
      operation(request, {
        provider: "app_store_connect",
        capability: "build_group_assignment",
        action: "testflight_group.build.add",
        title: "Assign the processed build to the verified TestFlight group",
        identity: { buildId, groupId },
        riskClass: "high",
        effectClass: "reversible_external",
        reversibility: "reversible",
        credentialRef: request.credentialRef,
        dependsOn: [
          ...(buildProcessingOperationId ? [buildProcessingOperationId] : []),
          ...(testflightGroupOperationId ? [testflightGroupOperationId] : []),
        ],
        http: {
          method: "POST",
          url: `https://api.appstoreconnect.apple.com/v1/betaGroups/${encoded(groupId)}/relationships/builds`,
          body: { data: [{ type: "builds", id: buildId }] },
          auth: appStoreAuth(request),
        },
        readBack: {
          transport: "http",
          http: {
            method: "GET",
            url: `https://api.appstoreconnect.apple.com/v1/betaGroups/${encoded(groupId)}/relationships/builds`,
            auth: appStoreAuth(request),
          },
          description: "App Store Connect returned the processed build in the TestFlight group",
          assertions: [
            { path: "data", operator: "contains", expected: { type: "builds", id: buildId } },
          ],
        },
        verification: {
          strategy: "response_then_read_back",
          description:
            "Require the exact processed build in the exact group; TestFlight access is not App Store publication",
        },
      }),
    );
  }
  if (hasCapability(request, "build_metadata")) {
    const detailId = inputString(request, "betaAppReviewDetailId");
    const contactFirstName = inputString(request, "contactFirstName");
    const contactLastName = inputString(request, "contactLastName");
    const contactEmail = inputString(request, "contactEmail");
    const contactPhone = inputString(request, "contactPhone");
    const notes = inputString(request, "reviewNotes");
    operations.push(
      operation(request, {
        provider: "app_store_connect",
        capability: "build_metadata",
        action: "beta_review_details.update",
        title: "Update TestFlight beta review contact details",
        identity: detailId,
        riskClass: "critical",
        effectClass: "communication",
        reversibility: "reversible",
        credentialRef: request.credentialRef,
        http: {
          method: "PATCH",
          url: `https://api.appstoreconnect.apple.com/v1/betaAppReviewDetails/${encoded(detailId)}`,
          body: {
            data: {
              type: "betaAppReviewDetails",
              id: detailId,
              attributes: {
                contactFirstName,
                contactLastName,
                contactEmail,
                contactPhone,
                notes,
              },
            },
          },
          auth: appStoreAuth(request),
        },
        readBack: {
          transport: "http",
          http: {
            method: "GET",
            url: `https://api.appstoreconnect.apple.com/v1/betaAppReviewDetails/${encoded(detailId)}`,
            auth: appStoreAuth(request),
          },
          description: "App Store Connect returned the beta review details",
          assertions: [
            {
              path: "data.attributes.contactEmail",
              operator: "equals",
              expected: contactEmail,
            },
            {
              path: "data.attributes.notes",
              operator: "equals",
              expected: notes,
            },
          ],
        },
        verification: {
          strategy: "read_back",
          description: "Compare the exact review contact fields and notes",
        },
      }),
    );
  }
  return createPlan("app_store_connect", request, operations, [
    "The API plan starts only after a human creates and verifies the first app record.",
  ]);
}

function easAuthEnvironment(request: ProviderPlanRequest) {
  return request.credentialRef
    ? { name: "EXPO_TOKEN", credentialRef: credentialInput(request) }
    : undefined;
}

export function buildEasPlan(request: ProviderPlanRequest): ProviderPlan {
  const operations: ProviderOperation[] = [];
  let buildOperationId: string | undefined;
  let appStoreConnectionOperationId: string | undefined;
  const projectDirectory = optionalString(request, "projectDirectory");
  if (hasCapability(request, "app_store_prerequisite")) {
    const name = inputString(request, "appName");
    const bundleId = inputString(request, "bundleId");
    const sku = inputString(request, "sku");
    operations.push(
      operation(request, {
        provider: "eas",
        capability: "app_store_prerequisite",
        action: "app_store_record.confirm_manual",
        title: `Create or confirm App Store record for ${name}`,
        identity: { name, bundleId, sku },
        riskClass: "critical",
        effectClass: "manual",
        reversibility: "manual",
        manual: {
          system: "App Store Connect web interface",
          url: "https://appstoreconnect.apple.com/apps",
          instructions: [
            "Search My Apps for the exact bundle identifier before creating anything.",
            `If absent, create the first app record with name ${name}, bundle id ${bundleId}, and SKU ${sku}.`,
            "Record the numeric Apple app id in the EAS submit profile.",
            "Do not start EAS submission until the record is visible and the bundle id matches.",
          ],
          requiredFields: { name, bundleId, sku },
          completionEvidence: [
            "Numeric Apple app id",
            "Matching bundle identifier",
            "EAS submit profile reference",
          ],
        },
        verification: {
          strategy: "manual",
          description: "Require a human-attested Apple app id before submission",
        },
      }),
    );
  }
  if (hasCapability(request, "app_store_connection")) {
    const appStoreAppId = inputString(request, "appStoreAppId");
    const bundleId = inputString(request, "bundleId");
    const connection = operation(request, {
      provider: "eas",
      capability: "app_store_connection",
      action: "app_store_connection.connect",
      title: `Connect EAS to App Store Connect app ${appStoreAppId}`,
      identity: { appStoreAppId, bundleId },
      riskClass: "critical",
      effectClass: "reversible_external",
      reversibility: "reversible",
      credentialRef: request.credentialRef,
      command: {
        binary: "eas",
        args: [
          "integrations:asc:connect",
          "--asc-app-id",
          appStoreAppId,
          "--bundle-id",
          bundleId,
          "--json",
          "--non-interactive",
        ],
        ...(projectDirectory ? { cwd: projectDirectory } : {}),
        authEnvironment: easAuthEnvironment(request),
      },
      readBack: {
        transport: "cli",
        command: {
          binary: "eas",
          args: ["integrations:asc:status", "--json", "--non-interactive"],
          ...(projectDirectory ? { cwd: projectDirectory } : {}),
          authEnvironment: easAuthEnvironment(request),
        },
        description: "EAS returned the linked App Store Connect app and bundle identifier",
        assertions: [
          { path: "", operator: "contains", expected: appStoreAppId },
          { path: "", operator: "contains", expected: bundleId },
        ],
      },
      verification: {
        strategy: "response_then_read_back",
        description: "Require the same-run Apple app id and bundle id from EAS link status",
      },
    });
    appStoreConnectionOperationId = connection.id;
    operations.push(connection);
  }
  if (hasCapability(request, "ios_build")) {
    const profile = optionalString(request, "buildProfile") ?? "production";
    const build = operation(request, {
      provider: "eas",
      capability: "ios_build",
      action: "ios.build",
      title: `Start EAS iOS build with ${profile} profile`,
      identity: { profile, environment: request.environment },
      riskClass: "critical",
      effectClass: "reversible_external",
      reversibility: "conditionally_reversible",
      credentialRef: request.credentialRef,
      command: {
        binary: "eas",
        args: ["build", "--platform", "ios", "--profile", profile, "--non-interactive", "--json"],
        ...(projectDirectory ? { cwd: projectDirectory } : {}),
        authEnvironment: easAuthEnvironment(request),
      },
      readBack: {
        transport: "cli",
        command: {
          binary: "eas",
          args: ["build:view", "{result.id}", "--json"],
          ...(projectDirectory ? { cwd: projectDirectory } : {}),
          authEnvironment: easAuthEnvironment(request),
        },
        description: "EAS returned a terminal build record by id",
        assertions: [
          { path: "id", operator: "equals", expected: "{result.id}" },
          { path: "platform", operator: "equals", expected: "IOS" },
          { path: "status", operator: "equals", expected: "FINISHED" },
          { path: "buildProfile", operator: "equals", expected: profile },
        ],
      },
      verification: {
        strategy: "response_then_read_back",
        description: "Require a finished build status and matching profile/platform",
      },
    });
    buildOperationId = build.id;
    operations.push(build);
  }
  if (hasCapability(request, "ios_submit")) {
    const buildId = inputString(request, "easBuildId");
    const profile = optionalString(request, "submitProfile") ?? "production";
    operations.push(
      operation(request, {
        provider: "eas",
        capability: "ios_submit",
        action: "ios.submit",
        title: `Submit EAS build ${buildId} to App Store Connect`,
        identity: { buildId, profile },
        riskClass: "critical",
        effectClass: "irreversible_external",
        reversibility: "conditionally_reversible",
        credentialRef: request.credentialRef,
        dependsOn: [
          ...(buildOperationId ? [buildOperationId] : []),
          ...(appStoreConnectionOperationId ? [appStoreConnectionOperationId] : []),
        ],
        command: {
          binary: "eas",
          args: [
            "submit",
            "--platform",
            "ios",
            "--profile",
            profile,
            "--id",
            buildId,
            "--non-interactive",
          ],
          ...(projectDirectory ? { cwd: projectDirectory } : {}),
          authEnvironment: easAuthEnvironment(request),
        },
        readBack: {
          transport: "cli",
          command: {
            binary: "eas",
            args: [
              "submit:list",
              "--platform",
              "ios",
              "--status",
              "finished",
              "--limit",
              "10",
              "--json",
              "--non-interactive",
            ],
            ...(projectDirectory ? { cwd: projectDirectory } : {}),
            authEnvironment: easAuthEnvironment(request),
          },
          description: "EAS returned the App Store submission state by id",
          assertions: [
            {
              path: "",
              operator: "contains",
              expected: {
                platform: "IOS",
                status: "FINISHED",
                submittedBuild: { id: buildId },
              },
            },
          ],
        },
        verification: {
          strategy: "response_then_read_back",
          description: "Require a finished submission state; do not infer Apple approval",
        },
      }),
    );
  }
  return createPlan("eas", request, operations, [
    "A completed EAS submission does not prove TestFlight processing or App Review approval.",
  ]);
}
