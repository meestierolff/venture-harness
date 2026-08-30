# DESIGN

- Status: FOUNDER-ALPHA REVIEWED
- Owner: Venture Harness Core
- Last updated: 2026-08-29

## Purpose

This record governs the Core repository's small public founder-alpha surface.
Generated ventures still use their own `$design-director` pass and retain their
own identity; they must not copy this one by default.

## Design thesis

Venture Harness should feel like a founder's field instrument: an editorial
paper ledger crossed with a launch rail. Each commitment advances through a
visible state, while the dashed external boundary makes the point where local
confidence ends and provider proof must begin. The system avoids the visual
language of a magical AI builder because the product is about reviewable
control, not spectacle.

## Emotional outcome

Within ten seconds, a founder should feel oriented and in control: there is one
next action, a finite path, and an honest boundary around what has not happened.

## Reference principles and anti-references

| Reference          | Principle borrowed (never pixels)                              |
| ------------------ | -------------------------------------------------------------- |
| Field notebooks    | Warm paper, small annotations, and visible evidence provenance |
| Transit diagrams   | A finite sequence with a legible current boundary              |
| Technical receipts | Monospaced state labels and conservative completion language   |

| Anti-reference         | What we refuse                                                 |
| ---------------------- | -------------------------------------------------------------- |
| Generic AI launch page | Purple glow, magic language, floating cards, or invented proof |
| Enterprise dashboard   | Dense navigation, control-plane chrome, or a wall of metrics   |
| Boilerplate gallery    | Repeated feature cards and interchangeable startup copy        |

## Art directions considered

| Direction                   | Essence                                   | Why (not) chosen                                             |
| --------------------------- | ----------------------------------------- | ------------------------------------------------------------ |
| Founder field instrument    | Editorial ledger plus evidence rail       | Chosen: makes review and external boundaries memorable       |
| Terminal-only operator page | Dense monospaced command surface          | Rejected: accurate but too austere for first-time founders   |
| Bright launch playbook      | Large color blocks and playful milestones | Rejected: risked implying ease or completion not in evidence |

## System

| Element               | Decision                                                                      | Notes                                                                         |
| --------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Colour system         | Warm paper, ink, forest, oxide, and marker yellow                             | Forest is control; oxide marks boundaries; yellow marks current review status |
| Typography            | System editorial serif for decisions; system sans for reading; mono for state | No external font request and no hidden tracking dependency                    |
| Logo direction        | Bracketed lowercase wordmark                                                  | Text-only and inspectable, not an arbitrary icon-plus-name mark               |
| Imagery               | None                                                                          | The product state diagram carries the visual meaning                          |
| Product visualisation | Labeled idea-to-evidence rail                                                 | Explicitly illustrative; not presented as provider evidence                   |
| Signature moment      | The solid local rail crosses a dashed external proof gate                     | Makes requested versus verified visible at a glance                           |
| Desktop composition   | Asymmetric editorial hero with the rail as the second focal point             | One dominant quickstart action                                                |
| Mobile composition    | Action moves directly after the title; rail follows before boundary notes     | Deliberate reorder, not a compressed desktop stack                            |
| Motion                | Hover feedback only                                                           | Reduced-motion disables transitions and smooth scrolling                      |
| Accessibility         | Visible focus, semantic landmarks, equal consent choices, AA contrast         | Browser and axe checks are required before sign-off                           |

## Anti-slop audit

- [x] No generic purple or trend-default AI gradient.
- [x] No glowing AI orb.
- [x] No arbitrary glassmorphism.
- [x] No six-card feature wall.
- [x] No random bento grid.
- [x] No floating card without a product purpose.
- [x] No generic stock illustration.
- [x] No copied Framer or recognizable template composition.
- [x] The bracketed text mark is not a standard icon beside a wordmark.
- [x] The paper, forest, oxide, and marker palette belongs to the evidence-rail
      thesis rather than a generic competitor page.
- [x] The editorial serif, reading sans, and state mono pairing is chosen for a
      skeptical founder-operator audience.
- [x] The local rail crossing a dashed external proof gate is the signature
      moment.
- [x] Mobile moves the action directly after the title and reflows the rail;
      it is not a hidden or clipped desktop stack.
- [x] Every section explains operation, evidence boundary, first run, or the
      labeled prototype; there is no filler viewport.
- [x] Each screen has one dominant action and the hierarchy survives squinting.
- [x] The hero describes an inspectable launch path and cannot be pasted onto a
      generic AI builder unchanged.
- [x] Public copy contains no phrase banned by `config/content.yaml`, and
      capability claims map to registered `TruthClaim` ids.
- [x] The rail is labeled illustrative, the form is labeled prototype, and no
      sample or external state is presented as live evidence.

## Evidence

- Implementation: `app/page.tsx`, `app/globals.css`, `app/layout.tsx`.
- Truth boundary: `docs/product/PRODUCT_TRUTH.md` and rendered `TruthClaim`
  wrappers.
- Mechanical review: `tests/e2e/accessibility.spec.ts` and
  `tests/e2e/critical-journeys.spec.ts`; the complete desktop/mobile browser
  suite passed 12/12 after the routed fixes.
- Independent desktop/mobile visual review performed on 2026-08-29; its
  clipping, contrast, collapsed-form, and template-record findings were routed
  back into the implementation before source freeze.

## Assumptions

- The repository surface is a small source/quickstart gateway, not a separate
  marketing site and not evidence of a live dogfood application.
- System serif and mono substitutions vary by operating system while preserving
  hierarchy; exact glyph matching is not a requirement.

## Unresolved questions

- A GitHub social-preview source exists, but upload remains a manual repository
  setting action.

## Related documents

- [BRAND.md](BRAND.md)
- [REFERENCES.md](REFERENCES.md)
- [../../inputs/DESIGN_BRIEF.md](../../inputs/DESIGN_BRIEF.md)
- [../../skills/design-director/SKILL.md](../../skills/design-director/SKILL.md)
