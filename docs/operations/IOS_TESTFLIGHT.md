# iOS and TestFlight

The router chooses Expo React Native, SwiftUI or records why `auto` selected one.
Expo suits fast cross-platform MVPs and standard device APIs; SwiftUI suits deep
Apple frameworks, strongly on-device work and native constraints.

## Required mobile contract

Record bundle identifier, app scheme, stack rationale, build profiles, signing
credential references, App Store team/app IDs, metadata artifact and screenshot
flow. Certificates and private keys never enter Git.

## First App Store Connect record

When Apple provides no supported API for the first app record, the run pauses and
requests exactly:

- app name;
- bundle identifier;
- SKU when required;
- primary language;
- resulting Apple app ID;
- team ID.

Create it in App Store Connect, capture the non-secret IDs and evidence through
the manual node, then resume with (node IDs follow the active dry run):

```bash
vh resume <run-id> --manual apple-first-app-record --evidence reports/launch/<run-id>/manual/apple-first-app-record.json
```

The evidence file is one typed `manual_action_evidence` artifact. Its `run_id`,
`node_id`, `approved_by`, verified status and `output` must match the resumed run;
the output contains `app_name`, `bundle_identifier`, nullable `sku`,
`primary_language`, `apple_app_id`, and `team_id`. The CLI reads that output from
the artifact, so a second `--output` file is optional and cannot replace evidence.

The `eas-build` node is independent of this manual record and may continue while
it waits. `eas-submit` cannot start until both have completed.

## Expo/EAS path

Use Expo Router as applicable and deterministic development, preview and
production profiles. The provider plan covers EAS build and submit through the
official CLI with brokered Expo/App Store credentials. The build stage exposes
only its same-run public build ID, app version and build number. The submit stage
connects the exact Apple app/bundle from the manual record, reads that connection
back, consumes the exact EAS build ID, submits it, and reads the submission ID and
status back.

`testflight-state` then queries App Store Connect for the same app version/build
number until one valid processed Apple build is returned, creates or locates the
named TestFlight group, assigns that exact build, and reads both relationships
back. Missing, duplicate or mismatched IDs stop the stage. This sequence does not
request beta review, external distribution, App Store submission, release or
publication.

The local `launch.prepareRepository` handler creates a deterministic,
create-only Expo scaffold under `mobile/expo/` when the routed stack is
`expo_react_native`. It writes a strict `.venture-scaffold.json` manifest,
preserves the founder-brief display name, records whether its bundle identifier
is configured or a `com.example.*` local placeholder, and configures no submit
operation. Canonical identifiers come from `config/mobile.yaml`, with typed brief
fields as the pre-sync fallback. It does not install its pinned dependency set. A rerun accepts only
the exact generated files; an unowned directory or changed generated file stops
with a conflict instead of being overwritten.

EAS Metadata is beta: treat generated metadata as a reviewable artifact and keep
an App Store Connect API/manual fallback. The current provider plan does not turn
a metadata artifact into a verified store listing by implication.

## SwiftUI path

Use a reproducible project-generation/build/test approach, secure signing
references and an official Apple-compatible upload path. A local archive or
successful compile is not a TestFlight upload.

For a routed `swiftui` rail, the same preparation handler creates
`mobile/ios/<VentureModule>.xcodeproj`, a shared scheme, and the smallest SwiftUI
entry/view sources. Project identifiers are derived deterministically from the
venture ID. The generator performs create-only writes plus content-hash
read-back, rejects symlink traversal, and stores no team, signing, credential,
submission, or publication state. Later product-build nodes replace the labeled
placeholder screen with the reviewed core journey.

## RevenueCat

For native digital goods, use one deterministic entitlement source. Separate
Apple store-product creation from RevenueCat mapping; verify purchase, unlock,
restore and webhook behavior in Test Store/sandbox and the required TestFlight
path.

## Authorization and truth

`mobile_testflight` may permit build/upload within the envelope. Public App Store
submission/publication is an irreversible effect with a distinct checkpoint.
Never call a build submitted, accepted, TestFlight-ready or live unless provider
state confirms that exact stage.
