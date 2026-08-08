import { createHash } from "node:crypto";
import type { MobileScaffoldStack, ParsedMobileScaffoldRequest } from "./types";

export interface MobileTemplateFile {
  relativePath: string;
  content: string;
}

export interface RenderedMobileTemplates {
  moduleName: string;
  files: MobileTemplateFile[];
  limitations: string[];
}

export const EXPO_TEMPLATE_TOOLCHAIN = {
  expo: "53.0.0",
  react: "19.0.0",
  reactNative: "0.79.2",
  typescript: "5.7.3",
} as const;

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function swiftString(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
}

function pbxString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function moduleNameFor(ventureId: string): string {
  return ventureId
    .split("-")
    .filter(Boolean)
    .map((segment) => `${segment[0].toUpperCase()}${segment.slice(1)}`)
    .join("");
}

function pbxId(ventureId: string, label: string): string {
  return createHash("sha256")
    .update(`venture-harness:${ventureId}:${label}`)
    .digest("hex")
    .slice(0, 24)
    .toUpperCase();
}

function expoTemplates(
  input: ParsedMobileScaffoldRequest,
  bundleIdentifier: string,
  appScheme: string,
): RenderedMobileTemplates {
  const moduleName = moduleNameFor(input.ventureId);
  const packageName = `${input.ventureId}-mobile`;
  const displayNameLiteral = JSON.stringify(input.displayName);

  return {
    moduleName,
    limitations: [
      "The scaffold pins an offline-reviewed Expo SDK compatibility set but does not install packages or prove a native build.",
      "EAS credentials, signing, submission, store metadata, purchases, and provider read-back remain unconfigured.",
    ],
    files: [
      {
        relativePath: "package.json",
        content: json({
          name: packageName,
          version: "0.1.0",
          private: true,
          main: "node_modules/expo/AppEntry.js",
          scripts: {
            start: "expo start",
            ios: "expo start --ios",
            android: "expo start --android",
            typecheck: "tsc --noEmit",
          },
          dependencies: {
            expo: EXPO_TEMPLATE_TOOLCHAIN.expo,
            react: EXPO_TEMPLATE_TOOLCHAIN.react,
            "react-native": EXPO_TEMPLATE_TOOLCHAIN.reactNative,
          },
          devDependencies: {
            "@types/react": "19.0.10",
            typescript: EXPO_TEMPLATE_TOOLCHAIN.typescript,
          },
        }),
      },
      {
        relativePath: "app.json",
        content: json({
          expo: {
            name: input.displayName,
            slug: input.ventureId,
            version: "0.1.0",
            orientation: "portrait",
            scheme: appScheme,
            userInterfaceStyle: "automatic",
            ios: {
              bundleIdentifier,
              supportsTablet: true,
            },
            extra: {
              ventureHarness: {
                scaffoldStatus: "local_prototype",
                submissionConfigured: false,
              },
            },
          },
        }),
      },
      {
        relativePath: "eas.json",
        content: json({
          cli: { appVersionSource: "local" },
          build: {
            development: { distribution: "internal" },
            preview: { distribution: "internal" },
            production: { autoIncrement: false },
          },
        }),
      },
      {
        relativePath: "tsconfig.json",
        content: json({
          extends: "expo/tsconfig.base",
          compilerOptions: {
            strict: true,
            noEmit: true,
          },
          include: ["**/*.ts", "**/*.tsx", ".expo/types/**/*.ts", "expo-env.d.ts"],
        }),
      },
      {
        relativePath: "expo-env.d.ts",
        content: '/// <reference types="expo/types" />\n',
      },
      {
        relativePath: "App.tsx",
        content: `import { ScaffoldScreen } from "./src/ScaffoldScreen";

export default function App() {
  return <ScaffoldScreen appName={${displayNameLiteral}} />;
}
`,
      },
      {
        relativePath: "src/ScaffoldScreen.tsx",
        content: `import { SafeAreaView, StyleSheet, Text, View } from "react-native";

export function ScaffoldScreen({ appName }: { appName: string }) {
  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.content}>
        <Text accessibilityRole="header" style={styles.eyebrow}>
          Local prototype scaffold
        </Text>
        <Text style={styles.title}>{appName}</Text>
        <Text style={styles.body}>
          Replace this bounded placeholder with the reviewed smallest core journey.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#F5F3EE" },
  content: { flex: 1, justifyContent: "center", padding: 24, gap: 12 },
  eyebrow: { color: "#425466", fontSize: 14, fontWeight: "600" },
  title: { color: "#17212B", fontSize: 32, fontWeight: "700" },
  body: { color: "#425466", fontSize: 17, lineHeight: 25 },
});
`,
      },
      {
        relativePath: ".gitignore",
        content: ".expo/\nnode_modules/\ndist/\nweb-build/\n",
      },
      {
        relativePath: "README.md",
        content: `# Generated Expo scaffold

This create-only scaffold is a local prototype for \`${input.ventureId}\`. It preserves the
founder brief's display name and records identifiers in \`.venture-scaffold.json\`.

No package installation, signing, EAS submission, store record, purchase, or live provider
state is implied. Review the core journey and dependency versions before installing or building.
`,
      },
    ],
  };
}

function swiftProject(
  input: ParsedMobileScaffoldRequest,
  moduleName: string,
  bundleIdentifier: string,
): string {
  const id = (label: string) => pbxId(input.ventureId, label);
  const project = id("project");
  const mainGroup = id("main-group");
  const productGroup = id("product-group");
  const sourceGroup = id("source-group");
  const target = id("app-target");
  const product = id("app-product");
  const appFile = id("app-file");
  const viewFile = id("view-file");
  const appBuildFile = id("app-build-file");
  const viewBuildFile = id("view-build-file");
  const sources = id("sources-phase");
  const resources = id("resources-phase");
  const frameworks = id("frameworks-phase");
  const projectConfigurations = id("project-config-list");
  const targetConfigurations = id("target-config-list");
  const projectDebug = id("project-debug");
  const projectRelease = id("project-release");
  const targetDebug = id("target-debug");
  const targetRelease = id("target-release");
  const quotedName = pbxString(input.displayName);

  return `// !$*UTF8*$!
{
	archiveVersion = 1;
	classes = {};
	objectVersion = 56;
	objects = {

/* Begin PBXBuildFile section */
		${appBuildFile} /* ${moduleName}App.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${appFile} /* ${moduleName}App.swift */; };
		${viewBuildFile} /* ScaffoldView.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${viewFile} /* ScaffoldView.swift */; };
/* End PBXBuildFile section */

/* Begin PBXFileReference section */
		${appFile} /* ${moduleName}App.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${moduleName}App.swift; sourceTree = "<group>"; };
		${viewFile} /* ScaffoldView.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ScaffoldView.swift; sourceTree = "<group>"; };
		${product} /* ${moduleName}.app */ = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = ${moduleName}.app; sourceTree = BUILT_PRODUCTS_DIR; };
/* End PBXFileReference section */

/* Begin PBXFrameworksBuildPhase section */
		${frameworks} /* Frameworks */ = {isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
/* End PBXFrameworksBuildPhase section */

/* Begin PBXGroup section */
		${mainGroup} = {isa = PBXGroup; children = (${sourceGroup} /* ${moduleName} */, ${productGroup} /* Products */); sourceTree = "<group>"; };
		${productGroup} /* Products */ = {isa = PBXGroup; children = (${product} /* ${moduleName}.app */); name = Products; sourceTree = "<group>"; };
		${sourceGroup} /* ${moduleName} */ = {isa = PBXGroup; children = (${appFile} /* ${moduleName}App.swift */, ${viewFile} /* ScaffoldView.swift */); path = ${moduleName}; sourceTree = "<group>"; };
/* End PBXGroup section */

/* Begin PBXNativeTarget section */
		${target} /* ${moduleName} */ = {isa = PBXNativeTarget; buildConfigurationList = ${targetConfigurations} /* Build configuration list for PBXNativeTarget "${moduleName}" */; buildPhases = (${sources} /* Sources */, ${frameworks} /* Frameworks */, ${resources} /* Resources */); buildRules = (); dependencies = (); name = ${moduleName}; productName = ${moduleName}; productReference = ${product} /* ${moduleName}.app */; productType = "com.apple.product-type.application"; };
/* End PBXNativeTarget section */

/* Begin PBXProject section */
		${project} /* Project object */ = {isa = PBXProject; attributes = {BuildIndependentTargetsInParallel = YES; LastSwiftUpdateCheck = 1500; LastUpgradeCheck = 1500; TargetAttributes = {${target} = {CreatedOnToolsVersion = 15.0; }; }; }; buildConfigurationList = ${projectConfigurations} /* Build configuration list for PBXProject "${moduleName}" */; compatibilityVersion = "Xcode 14.0"; developmentRegion = en; hasScannedForEncodings = 0; knownRegions = (en, Base); mainGroup = ${mainGroup}; productRefGroup = ${productGroup} /* Products */; projectDirPath = ""; projectRoot = ""; targets = (${target} /* ${moduleName} */); };
/* End PBXProject section */

/* Begin PBXResourcesBuildPhase section */
		${resources} /* Resources */ = {isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
/* End PBXResourcesBuildPhase section */

/* Begin PBXSourcesBuildPhase section */
		${sources} /* Sources */ = {isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (${appBuildFile} /* ${moduleName}App.swift in Sources */, ${viewBuildFile} /* ScaffoldView.swift in Sources */); runOnlyForDeploymentPostprocessing = 0; };
/* End PBXSourcesBuildPhase section */

/* Begin XCBuildConfiguration section */
		${projectDebug} /* Debug */ = {isa = XCBuildConfiguration; buildSettings = {ALWAYS_SEARCH_USER_PATHS = NO; CLANG_ENABLE_MODULES = YES; SWIFT_OPTIMIZATION_LEVEL = "-Onone"; }; name = Debug; };
		${projectRelease} /* Release */ = {isa = XCBuildConfiguration; buildSettings = {ALWAYS_SEARCH_USER_PATHS = NO; CLANG_ENABLE_MODULES = YES; SWIFT_COMPILATION_MODE = wholemodule; }; name = Release; };
		${targetDebug} /* Debug */ = {isa = XCBuildConfiguration; buildSettings = {CODE_SIGN_STYLE = Automatic; CURRENT_PROJECT_VERSION = 1; GENERATE_INFOPLIST_FILE = YES; INFOPLIST_KEY_CFBundleDisplayName = ${quotedName}; IPHONEOS_DEPLOYMENT_TARGET = 16.0; MARKETING_VERSION = 0.1.0; PRODUCT_BUNDLE_IDENTIFIER = ${bundleIdentifier}; PRODUCT_NAME = "$(TARGET_NAME)"; SDKROOT = iphoneos; SUPPORTED_PLATFORMS = "iphoneos iphonesimulator"; SWIFT_VERSION = 5.0; TARGETED_DEVICE_FAMILY = "1,2"; }; name = Debug; };
		${targetRelease} /* Release */ = {isa = XCBuildConfiguration; buildSettings = {CODE_SIGN_STYLE = Automatic; CURRENT_PROJECT_VERSION = 1; GENERATE_INFOPLIST_FILE = YES; INFOPLIST_KEY_CFBundleDisplayName = ${quotedName}; IPHONEOS_DEPLOYMENT_TARGET = 16.0; MARKETING_VERSION = 0.1.0; PRODUCT_BUNDLE_IDENTIFIER = ${bundleIdentifier}; PRODUCT_NAME = "$(TARGET_NAME)"; SDKROOT = iphoneos; SUPPORTED_PLATFORMS = "iphoneos iphonesimulator"; SWIFT_VERSION = 5.0; TARGETED_DEVICE_FAMILY = "1,2"; }; name = Release; };
/* End XCBuildConfiguration section */

/* Begin XCConfigurationList section */
		${projectConfigurations} /* Build configuration list for PBXProject "${moduleName}" */ = {isa = XCConfigurationList; buildConfigurations = (${projectDebug} /* Debug */, ${projectRelease} /* Release */); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };
		${targetConfigurations} /* Build configuration list for PBXNativeTarget "${moduleName}" */ = {isa = XCConfigurationList; buildConfigurations = (${targetDebug} /* Debug */, ${targetRelease} /* Release */); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };
/* End XCConfigurationList section */
	};
	rootObject = ${project} /* Project object */;
}
`;
}

function swiftUiTemplates(
  input: ParsedMobileScaffoldRequest,
  bundleIdentifier: string,
  appScheme: string,
): RenderedMobileTemplates {
  const moduleName = moduleNameFor(input.ventureId);
  const displayName = swiftString(input.displayName);
  return {
    moduleName,
    limitations: [
      "The native project is unsigned and local-only until Apple identifiers and signing references are reviewed.",
      "A parsed project or simulator compile does not prove archive, upload, TestFlight processing, store metadata, purchases, or publication.",
    ],
    files: [
      {
        relativePath: `${moduleName}/${moduleName}App.swift`,
        content: `import SwiftUI

@main
struct ${moduleName}App: App {
    var body: some Scene {
        WindowGroup {
            ScaffoldView(appName: "${displayName}")
        }
    }
}
`,
      },
      {
        relativePath: `${moduleName}/ScaffoldView.swift`,
        content: `import SwiftUI

struct ScaffoldView: View {
    let appName: String

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Local prototype scaffold")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(appName)
                .font(.largeTitle.bold())
            Text("Replace this bounded placeholder with the reviewed smallest core journey.")
                .font(.body)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .padding(24)
        .background(Color(red: 0.96, green: 0.95, blue: 0.93))
        .accessibilityElement(children: .contain)
    }
}
`,
      },
      {
        relativePath: `${moduleName}.xcodeproj/project.pbxproj`,
        content: swiftProject(input, moduleName, bundleIdentifier),
      },
      {
        relativePath: `${moduleName}.xcodeproj/xcshareddata/xcschemes/${moduleName}.xcscheme`,
        content: `<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="1500" version="1.7">
  <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES">
    <BuildActionEntries>
      <BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">
        <BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${pbxId(input.ventureId, "app-target")}" BuildableName="${moduleName}.app" BlueprintName="${moduleName}" ReferencedContainer="container:${moduleName}.xcodeproj" />
      </BuildActionEntry>
    </BuildActionEntries>
  </BuildAction>
  <TestAction buildConfiguration="Debug" shouldUseLaunchSchemeArgsEnv="YES" />
  <LaunchAction buildConfiguration="Debug" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES">
    <BuildableProductRunnable runnableDebuggingMode="0">
      <BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${pbxId(input.ventureId, "app-target")}" BuildableName="${moduleName}.app" BlueprintName="${moduleName}" ReferencedContainer="container:${moduleName}.xcodeproj" />
    </BuildableProductRunnable>
  </LaunchAction>
  <ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES" />
  <AnalyzeAction buildConfiguration="Debug" />
  <ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES" />
</Scheme>
`,
      },
      {
        relativePath: ".gitignore",
        content: "DerivedData/\n*.xcuserstate\nxcuserdata/\n",
      },
      {
        relativePath: "README.md",
        content: `# Generated SwiftUI scaffold

This create-only scaffold is a local prototype for \`${input.ventureId}\`. The shared
\`${moduleName}\` scheme and project are deterministic; the URL scheme reserved for later reviewed
configuration is \`${appScheme}\`.

No signing, archive, upload, App Store record, purchase, or live provider state is implied.
`,
      },
    ],
  };
}

export function renderMobileTemplates(
  input: ParsedMobileScaffoldRequest,
  bundleIdentifier: string,
  appScheme: string,
): RenderedMobileTemplates {
  const renderer: Record<
    MobileScaffoldStack,
    (
      request: ParsedMobileScaffoldRequest,
      identifier: string,
      scheme: string,
    ) => RenderedMobileTemplates
  > = {
    expo_react_native: expoTemplates,
    swiftui: swiftUiTemplates,
  };
  return renderer[input.stack](input, bundleIdentifier, appScheme);
}
