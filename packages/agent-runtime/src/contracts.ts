import {
  defineRuntimeSchema,
  objectValue,
  schemaObject,
  stringValue,
} from "@venture-harness/config";
import { defineCommandContract } from "@venture-harness/command-bus";
import type { JsonObject } from "@venture-harness/core";

export type CampaignLaunchInput = JsonObject & {
  campaignId: string;
  channel: "organic" | "paid";
  objective: string;
};

export type CampaignLaunchOutput = JsonObject & {
  commandId: "campaigns.launch";
  ventureId: string;
  campaignId: string;
  channel: "organic" | "paid";
  status: "planned";
};

export type LaunchExecuteInput = JsonObject & {
  launchId: string;
  mode: "preview" | "production";
  dryRun: boolean;
};

export type LaunchExecuteOutput = JsonObject & {
  commandId: "launch.execute";
  ventureId: string;
  runId: string;
  mode: "preview" | "production";
  status: "accepted";
  dryRun: boolean;
};

const campaignInput = defineRuntimeSchema<CampaignLaunchInput>({
  name: "CampaignLaunchInput",
  jsonSchema: schemaObject(
    {
      campaignId: { type: "string", minLength: 1 },
      channel: { type: "string", enum: ["organic", "paid"] },
      objective: { type: "string", minLength: 1 },
    },
    ["campaignId", "channel", "objective"],
  ),
  parse(value) {
    const input = objectValue(value, "CampaignLaunchInput");
    return {
      campaignId: stringValue(input, "campaignId")!,
      channel: stringValue(input, "channel", { allowed: ["organic", "paid"] }) as
        "organic" | "paid",
      objective: stringValue(input, "objective")!,
    };
  },
});

const campaignOutput = defineRuntimeSchema<CampaignLaunchOutput>({
  name: "CampaignLaunchOutput",
  jsonSchema: schemaObject(
    {
      commandId: { const: "campaigns.launch" },
      ventureId: { type: "string" },
      campaignId: { type: "string" },
      channel: { type: "string", enum: ["organic", "paid"] },
      status: { const: "planned" },
    },
    ["commandId", "ventureId", "campaignId", "channel", "status"],
  ),
  parse(value) {
    const output = objectValue(value, "CampaignLaunchOutput");
    if (output.commandId !== "campaigns.launch" || output.status !== "planned")
      throw new Error("invalid campaign launch output");
    return {
      commandId: "campaigns.launch",
      ventureId: stringValue(output, "ventureId")!,
      campaignId: stringValue(output, "campaignId")!,
      channel: stringValue(output, "channel", { allowed: ["organic", "paid"] }) as
        "organic" | "paid",
      status: "planned",
    };
  },
});

const launchInput = defineRuntimeSchema<LaunchExecuteInput>({
  name: "LaunchExecuteInput",
  jsonSchema: schemaObject(
    {
      launchId: { type: "string", minLength: 1 },
      mode: { type: "string", enum: ["preview", "production"] },
      dryRun: { type: "boolean" },
    },
    ["launchId", "mode", "dryRun"],
  ),
  parse(value) {
    const input = objectValue(value, "LaunchExecuteInput");
    if (typeof input.dryRun !== "boolean") throw new Error("dryRun must be a boolean");
    return {
      launchId: stringValue(input, "launchId")!,
      mode: stringValue(input, "mode", { allowed: ["preview", "production"] }) as
        "preview" | "production",
      dryRun: input.dryRun,
    };
  },
});

const launchOutput = defineRuntimeSchema<LaunchExecuteOutput>({
  name: "LaunchExecuteOutput",
  jsonSchema: schemaObject(
    {
      commandId: { const: "launch.execute" },
      ventureId: { type: "string" },
      runId: { type: "string" },
      mode: { type: "string", enum: ["preview", "production"] },
      status: { const: "accepted" },
      dryRun: { type: "boolean" },
    },
    ["commandId", "ventureId", "runId", "mode", "status", "dryRun"],
  ),
  parse(value) {
    const output = objectValue(value, "LaunchExecuteOutput");
    if (
      output.commandId !== "launch.execute" ||
      output.status !== "accepted" ||
      typeof output.dryRun !== "boolean"
    ) {
      throw new Error("invalid launch execution output");
    }
    return {
      commandId: "launch.execute",
      ventureId: stringValue(output, "ventureId")!,
      runId: stringValue(output, "runId")!,
      mode: stringValue(output, "mode", { allowed: ["preview", "production"] }) as
        "preview" | "production",
      status: "accepted",
      dryRun: output.dryRun,
    };
  },
});

export const campaignLaunchCommand = defineCommandContract<
  CampaignLaunchInput,
  CampaignLaunchOutput
>({
  id: "campaigns.launch",
  version: 1,
  title: "Launch Campaign",
  description: "Plan one venture campaign through its declared channel.",
  input: campaignInput,
  output: campaignOutput,
  requirements: {
    activeSubscription: true,
    entitlements: ["campaigns.launch"],
    grant: true,
    scopes: ["campaigns:write"],
  },
  meter: "campaign_launches",
});

export const launchExecuteCommand = defineCommandContract<LaunchExecuteInput, LaunchExecuteOutput>({
  id: "launch.execute",
  version: 1,
  title: "Execute Venture Launch",
  description: "Accept one authorized preview or production launch run.",
  input: launchInput,
  output: launchOutput,
  requirements: {
    activeSubscription: true,
    entitlements: ["launch.execute"],
    grant: true,
    scopes: ["launch:execute"],
  },
  meter: "launch_runs",
});

export const ventureCommandContracts = [campaignLaunchCommand, launchExecuteCommand] as const;
