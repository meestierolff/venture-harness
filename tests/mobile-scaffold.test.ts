import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import type { CommandRunner } from "@/lib/credentials";
import { createDefaultMobileConfig } from "@/lib/config/mobile-schema";
import { founderBriefSchema, type FounderBrief } from "@/lib/launch";
import {
  EXPO_TEMPLATE_TOOLCHAIN,
  generateMobileScaffold,
  mobileScaffoldManifestSchema,
  type MobileScaffoldError,
  type MobileScaffoldStack,
} from "@/lib/mobile";
import {
  createLaunchProductBindings,
  type BuildAgentHost,
  type BuildAgentRequest,
  type BuildAgentResult,
} from "@/lib/runtime";
import { workflowNode, type WorkflowHandlerContext } from "@/lib/workflow";

const temporaryDirectories: string[] = [];

function temporaryRoot(prefix = "vh-mobile-scaffold-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function syntaxDiagnostics(path: string): readonly ts.Diagnostic[] {
  const source = readFileSync(path, "utf8");
  return (
    ts.transpileModule(source, {
      fileName: path,
      reportDiagnostics: true,
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    }).diagnostics ?? []
  ).filter(({ category }) => category === ts.DiagnosticCategory.Error);
}

function context(runId: string): WorkflowHandlerContext {
  return {
    runId,
    node: workflowNode("prepare-repository", {
      purpose: "Create the venture-owned local scaffold and managed-file manifest.",
      handler: "launch.prepareRepository",
      effect: "local_write",
      evidence: { required: true, artifact: "reports/launch/local-scaffold.json" },
    }),
    attempt: 1,
    dependencyOutputs: {},
    idempotencyKey: `${runId}:prepare-repository`,
    signal: new AbortController().signal,
    trace: () => undefined,
  };
}

class NoopHost implements BuildAgentHost {
  readonly id = "unused_build_agent";
  readonly requests: BuildAgentRequest[] = [];

  async inspect() {
    return {
      host: this.id,
      status: "available" as const,
      version: "test",
      billingMode: "fixture_no_model_execution" as const,
      billingEvidence: "fixture_attestation" as const,
      nextAction: null,
    };
  }

  async run(request: BuildAgentRequest): Promise<BuildAgentResult> {
    this.requests.push(request);
    throw new Error("The deterministic mobile preparation path must not invoke the build agent.");
  }
}

const noCommands: CommandRunner = {
  async run(invocation) {
    throw new Error(`Unexpected command: ${invocation.command}`);
  },
};

const iosFixture = founderBriefSchema.parse(
  parse(readFileSync("fixtures/ios-subscription/brief.yaml", "utf8")),
);

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("repo-native mobile scaffold generation", () => {
  it("creates a deterministic Expo scaffold and validates representative TSX syntax", () => {
    const root = temporaryRoot();
    const request = {
      stack: "expo_react_native" as const,
      ventureId: "focus-timer",
      displayName: "Focus Timer",
      bundleIdentifier: "com.example.focus-timer",
      appScheme: "focus-timer",
    };

    const first = generateMobileScaffold(root, request);
    const manifest = mobileScaffoldManifestSchema.parse(readJson(join(root, first.manifestPath)));
    const packageJson = readJson(join(root, "mobile/expo/package.json")) as {
      dependencies: Record<string, string>;
    };
    const appJson = readJson(join(root, "mobile/expo/app.json")) as {
      expo: { name: string; ios: { bundleIdentifier: string } };
    };

    expect(manifest).toMatchObject({
      stack: "expo_react_native",
      displayName: "Focus Timer",
      identity: {
        bundleIdentifier: "com.example.focus-timer",
        bundleIdentifierState: "configured",
        appScheme: "focus-timer",
        appSchemeState: "configured",
      },
      safeguards: {
        noOverwrite: true,
        credentialsPersisted: false,
        signingMaterialPersisted: false,
        submissionConfigured: false,
      },
    });
    expect(packageJson.dependencies).toEqual({
      expo: EXPO_TEMPLATE_TOOLCHAIN.expo,
      react: EXPO_TEMPLATE_TOOLCHAIN.react,
      "react-native": EXPO_TEMPLATE_TOOLCHAIN.reactNative,
    });
    expect(appJson.expo).toMatchObject({
      name: "Focus Timer",
      ios: { bundleIdentifier: "com.example.focus-timer" },
    });
    expect(syntaxDiagnostics(join(root, "mobile/expo/App.tsx"))).toEqual([]);
    expect(syntaxDiagnostics(join(root, "mobile/expo/src/ScaffoldScreen.tsx"))).toEqual([]);
    expect(first.createdFiles).toContain("mobile/expo/.venture-scaffold.json");

    const second = generateMobileScaffold(root, request);
    expect(second.createdFiles).toEqual([]);
    expect(second.unchangedFiles).toEqual(first.createdFiles);
  });

  it("creates a stable SwiftUI Xcode project and parses its Swift sources when swiftc is available", () => {
    const root = temporaryRoot();
    const result = generateMobileScaffold(root, {
      stack: "swiftui",
      ventureId: "native-focus",
      displayName: "Native Focus",
      bundleIdentifier: "nl.example.native-focus",
      appScheme: "native-focus",
    });
    const project = readFileSync(
      join(root, "mobile/ios/NativeFocus.xcodeproj/project.pbxproj"),
      "utf8",
    );
    const scheme = readFileSync(
      join(root, "mobile/ios/NativeFocus.xcodeproj/xcshareddata/xcschemes/NativeFocus.xcscheme"),
      "utf8",
    );
    const swiftFiles = [
      join(root, "mobile/ios/NativeFocus/NativeFocusApp.swift"),
      join(root, "mobile/ios/NativeFocus/ScaffoldView.swift"),
    ];

    expect(project).toContain("PRODUCT_BUNDLE_IDENTIFIER = nl.example.native-focus;");
    expect(project).toContain('productType = "com.apple.product-type.application"');
    expect(project).toContain("ScaffoldView.swift in Sources");
    expect(scheme).toContain('BuildableName="NativeFocus.app"');
    expect(new Set(project.match(/\b[A-F0-9]{24}\b/g)).size).toBeGreaterThanOrEqual(18);
    expect(result.manifest.identity.bundleIdentifierState).toBe("configured");

    const swiftCompiler = spawnSync("swiftc", ["--version"], { encoding: "utf8" });
    if (!swiftCompiler.error && swiftCompiler.status === 0) {
      const parsed = spawnSync("swiftc", ["-frontend", "-parse", ...swiftFiles], {
        encoding: "utf8",
      });
      expect(parsed.status, parsed.stderr).toBe(0);
    } else {
      for (const file of swiftFiles) {
        const source = readFileSync(file, "utf8");
        expect(source).toMatch(/^import SwiftUI/m);
        expect(source).not.toMatch(/(?:BEGIN .*PRIVATE KEY|\b(?:api[_-]?key|password)\b)/i);
      }
    }

    const xcode = spawnSync("xcodebuild", ["-version"], { encoding: "utf8" });
    if (!xcode.error && xcode.status === 0) {
      const projectPath = join(root, "mobile/ios/NativeFocus.xcodeproj");
      const listed = spawnSync("xcodebuild", ["-list", "-json", "-project", projectPath], {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      });
      expect(listed.status, listed.stderr).toBe(0);
      expect(JSON.parse(listed.stdout)).toMatchObject({
        project: { targets: ["NativeFocus"], schemes: ["NativeFocus"] },
      });
      const built = spawnSync(
        "xcodebuild",
        [
          "-project",
          projectPath,
          "-scheme",
          "NativeFocus",
          "-configuration",
          "Debug",
          "-sdk",
          "iphonesimulator",
          "-destination",
          "generic/platform=iOS Simulator",
          "-derivedDataPath",
          join(root, "derived-data"),
          "CODE_SIGNING_ALLOWED=NO",
          "build",
        ],
        { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
      );
      expect(built.status, `${built.stdout}\n${built.stderr}`.slice(-8_000)).toBe(0);
    }
  }, 90_000);

  it("fails before writing when output is unowned, modified, unsafe, or credential-shaped", () => {
    const unownedRoot = temporaryRoot();
    mkdirSync(join(unownedRoot, "mobile/expo"), { recursive: true });
    writeFileSync(join(unownedRoot, "mobile/expo/README.md"), "founder-owned\n");
    expect(() =>
      generateMobileScaffold(unownedRoot, {
        stack: "expo_react_native",
        ventureId: "safe-app",
        displayName: "Safe App",
      }),
    ).toThrowError(/existing unowned directory/);
    expect(readFileSync(join(unownedRoot, "mobile/expo/README.md"), "utf8")).toBe(
      "founder-owned\n",
    );
    expect(existsSync(join(unownedRoot, "mobile/expo/package.json"))).toBe(false);

    const modifiedRoot = temporaryRoot();
    generateMobileScaffold(modifiedRoot, {
      stack: "expo_react_native",
      ventureId: "safe-app",
      displayName: "Safe App",
    });
    writeFileSync(join(modifiedRoot, "mobile/expo/App.tsx"), "founder customization\n");
    expect(() =>
      generateMobileScaffold(modifiedRoot, {
        stack: "expo_react_native",
        ventureId: "safe-app",
        displayName: "Safe App",
      }),
    ).toThrowError(/Refusing to overwrite existing content/);
    expect(readFileSync(join(modifiedRoot, "mobile/expo/App.tsx"), "utf8")).toBe(
      "founder customization\n",
    );

    expect(() =>
      generateMobileScaffold(temporaryRoot(), {
        stack: "swiftui",
        ventureId: "safe-app",
        displayName: "Safe App",
        outputDirectory: "../outside",
      }),
    ).toThrow();
    expect(() =>
      generateMobileScaffold(temporaryRoot(), {
        stack: "swiftui",
        ventureId: "safe-app",
        displayName: "sk_live_1234567890abcdef",
      }),
    ).toThrow(/credential/i);

    const symlinkRoot = temporaryRoot();
    const outside = temporaryRoot("vh-mobile-outside-");
    mkdirSync(join(symlinkRoot, "mobile"));
    symlinkSync(outside, join(symlinkRoot, "mobile/ios"));
    let symlinkError: MobileScaffoldError | undefined;
    try {
      generateMobileScaffold(symlinkRoot, {
        stack: "swiftui",
        ventureId: "safe-app",
        displayName: "Safe App",
      });
    } catch (error) {
      symlinkError = error as MobileScaffoldError;
    }
    expect(symlinkError).toMatchObject({ code: "unsafe_path" });
    expect(existsSync(join(outside, ".venture-scaffold.json"))).toBe(false);
  });

  it.each([
    ["expo_react_native", "mobile/expo/.venture-scaffold.json"],
    ["swiftui", "mobile/ios/.venture-scaffold.json"],
  ] as const)(
    "routes %s preparation through the deterministic product binding",
    async (stack: MobileScaffoldStack, manifestPath: string) => {
      const root = temporaryRoot();
      const host = new NoopHost();
      const mobileConfig = createDefaultMobileConfig();
      mobileConfig.mobile.stack = stack;
      mobileConfig.mobile.rationale = "Configured test identity for the selected mobile rail.";
      mobileConfig.mobile.bundle_identifier = `test.example.${stack === "swiftui" ? "swift" : "expo"}`;
      mobileConfig.mobile.app_scheme = stack === "swiftui" ? "swift-fixture" : "expo-fixture";
      mkdirSync(join(root, "config"));
      writeFileSync(join(root, "config/mobile.yaml"), stringify(mobileConfig));
      const brief: FounderBrief = founderBriefSchema.parse({
        ...iosFixture,
        id: `${stack === "swiftui" ? "swift" : "expo"}-binding-fixture`,
        name: stack === "swiftui" ? "Swift Binding Fixture" : "Expo Binding Fixture",
        app_kind: "mobile_ios",
        requested_mobile_stack: stack,
      });
      const bindings = createLaunchProductBindings({
        rootDir: root,
        brief,
        agentHost: host,
        commandRunner: noCommands,
        now: () => new Date("2026-08-04T12:00:00.000Z"),
      });

      const result = await bindings.handlers!["launch.prepareRepository"](
        context(`mobile-${stack}`),
      );

      expect(result.effectVerified).toBe(true);
      expect(result.output).toMatchObject({
        status: "completed",
        host: "repo_native_mobile_scaffold",
        scaffold: { stack, manifestPath },
      });
      expect(host.requests).toEqual([]);
      expect(existsSync(join(root, manifestPath))).toBe(true);
      expect(readJson(join(root, manifestPath))).toMatchObject({
        identity: {
          bundleIdentifier: `test.example.${stack === "swiftui" ? "swift" : "expo"}`,
          bundleIdentifierState: "configured",
          appScheme: stack === "swiftui" ? "swift-fixture" : "expo-fixture",
          appSchemeState: "configured",
        },
      });
      const evidencePath = join(
        root,
        `reports/launch/mobile-${stack}/product/prepare-repository.json`,
      );
      expect(readJson(evidencePath)).toMatchObject({
        host: "repo_native_mobile_scaffold",
        result: { scaffold: { stack } },
        rawPromptPersisted: false,
      });
    },
  );

  it("uses brief identity when canonical mobile config has not been written yet", async () => {
    const root = temporaryRoot();
    const host = new NoopHost();
    const brief = founderBriefSchema.parse({
      ...iosFixture,
      id: "brief-identity",
      name: "Brief Identity",
      app_kind: "mobile_ios",
      requested_mobile_stack: "expo_react_native",
      bundle_identifier: "nl.example.brief-identity",
      app_scheme: "brief-identity",
    });
    const bindings = createLaunchProductBindings({
      rootDir: root,
      brief,
      agentHost: host,
      commandRunner: noCommands,
    });

    await bindings.handlers!["launch.prepareRepository"](context("mobile-brief-identity"));

    expect(readJson(join(root, "mobile/expo/.venture-scaffold.json"))).toMatchObject({
      identity: {
        bundleIdentifier: "nl.example.brief-identity",
        bundleIdentifierState: "configured",
        appScheme: "brief-identity",
        appSchemeState: "configured",
      },
    });
    expect(host.requests).toEqual([]);
  });
});
