---
name: mobile-launch
description: Select and execute the iOS product rail, choosing Expo React Native, SwiftUI, or hybrid delivery; configure secure builds, EAS/App Store Connect/TestFlight, RevenueCat entitlements, store metadata, deterministic screenshots, and ASO verification. Use for mobile_ios, mobile_cross_platform, or hybrid ventures; never claim submission or publication without provider confirmation.
---

<!-- GENERATED FILE - do not edit. Canonical source: skills/mobile-launch/SKILL.md. Regenerate with: pnpm agents:sync -->

# mobile-launch

## Purpose

Build the smallest useful iOS MVP and move it to verified TestFlight readiness
through reproducible, credential-safe paths.

## Trigger conditions

- The launch contract selects iOS, cross-platform mobile, or hybrid.
- Mobile stack, signing, TestFlight, store metadata, purchases, or ASO is in scope.

## When not to use

- Web-only launches or Android-only work.
- Store publication without an explicit release authorization.

## Required inputs

Core journey, device/native requirements, target platforms, privacy/risk,
bundle/app identifiers, entitlement source, Apple/Expo credential refs,
authorization envelope, and product truth.

## Documents to read

Read the mobile/launch/provider contracts, product truth, architecture, privacy
inventory, and ASO playbook.

## Files this skill may change

Expo/SwiftUI venture code, secure-reference build config, deterministic tests
and screenshot/store assets, web support/privacy rail, and sanitized reports.

## Files this skill must not change

Certificates, private keys, provisioning secrets, unverified Apple/RevenueCat
IDs, or web entitlement logic that creates a second source of truth.

## Execution steps

1. Prefer Expo for simple consumer MVPs, shared TypeScript, common device APIs,
   cross-platform value, and iteration speed; prefer SwiftUI for Apple-first,
   deep native/on-device/framework needs. Record the rationale.
2. Configure identifiers, scheme, dev/preview/production profiles, tests, and
   deterministic build path.
3. Model the first App Store record as a manual action when absent; request only
   name, bundle ID, SKU if required, language, Apple app ID, and team ID.
4. Continue independent code, metadata, screenshots, web, backend, and Test
   Store work while waiting; resume with recorded identifiers.
5. Configure EAS or official Apple-compatible build/upload using credential refs.
6. Route native digital purchases to RevenueCat unless a documented policy
   decision chooses otherwise; test purchase, restore, webhook, and entitlement.
7. Verify build processing, TestFlight group/state, metadata, ASO, crashes, and
   privacy/support routes by provider read-back.

## Hard rules

- Never store signing material or keys in Git.
- Upload, processing, TestFlight, review submission, and live are distinct states.
- Never assert Apple store products before verification.
- One entitlement source of truth; Stripe and RevenueCat coexist only with an
  explicit hybrid design.
- EAS Metadata beta status remains labeled with an Apple API/manual fallback.

## Expected output

A reproducible mobile rail, verified tests/build readiness, explicit Apple
manual input when needed, TestFlight evidence when authorized, and ASO report.

## Validation

Run unit/UI tests, mobile config validation, deterministic screenshot/metadata
checks, sandbox/Test Store purchase and restore tests, and provider dry run.

## Failure behaviour

Persist provider/build state, continue independent nodes, and return the exact
identifier, agreement, credential, signing, processing, or review action needed.

## Human approval boundaries

First-time Apple account agreements/actions, real store product configuration
when outside the envelope, external testing where required, review submission,
and App Store publication remain explicit checkpoints.
