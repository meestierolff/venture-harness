# Core public-surface design record

- Status: FOUNDER ALPHA — local and fixture tested
- Owner: Venture Harness Core
- Last updated: 2026-08-27

## Purpose

Record the visual rationale and evidence boundary for the public Core repository
so its founder-alpha presentation can be reviewed without filling the generic
venture design template.

## Scope

This record governs the Venture Harness repository README, hero, and GitHub
social-preview source. It does not replace the venture-specific `DESIGN.md`
template used by generated companies.

## Thesis and emotional outcome

Venture Harness should feel like a compact field instrument for crossing the
gap between an idea and accountable launch evidence. The visual system borrows
the clarity of a build ledger: one strong horizontal route, numbered or named
states, honest qualifiers, and no decorative product theatre. A founder should
feel oriented and in control within ten seconds, never dazzled into mistaking a
fixture for live proof.

## Directions considered

| Direction               | Decision | Reason                                                                             |
| ----------------------- | -------- | ---------------------------------------------------------------------------------- |
| Technical launch ledger | selected | Makes progression, evidence, and pending read-back immediately legible             |
| Polished SaaS dashboard | rejected | Would make the Core look like the hosted control plane it explicitly is not        |
| Futuristic AI spectacle | rejected | Gradients, glow, and agent imagery would obscure ownership and evidence boundaries |

## System

| Element                   | Decision                        | Rationale                                                                                                |
| ------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Ivory `#F4F0E6`           | primary field                   | Warmer and more editorial than a generic developer-tool white                                            |
| Ink `#171A17`             | primary type and rail           | High-contrast, stable reading colour                                                                     |
| Green `#1E644C`           | evidence and open-source accent | Marks review/read-back concepts without implying every node is complete                                  |
| Orange `#D35F32`          | non-text directional arrow      | A single energetic transition; never used for small body text                                            |
| Burnt orange `#B44B26`    | optional accent text            | Meets normal-text AA contrast on ivory                                                                   |
| System sans + system mono | typography                      | Loads nowhere, works in GitHub, and pairs editorial hierarchy with inspectable command/evidence language |
| Launch-evidence rail      | signature moment                | One hollow-node path makes the contract → stack → read-back → receipt relationship memorable             |

All endpoint nodes remain hollow until a specific receipt supplies live
read-back. The graphics visibly say `LOCAL + FIXTURE TESTED`; they never use a
solid completed endpoint as generic decoration.

## Responsive composition

The README hero uses a compact `960 × 620` viewBox instead of scaling a wide
desktop timeline. At a 375 px rendering, the 32 px evidence qualifier remains
approximately 12.5 px, the headline remains dominant, and five verbose labels
collapse into one simplified stage line. The social preview keeps the same
message at its native `1280 × 640` sharing ratio.

## Accessibility and motion

- Ink and green text exceed WCAG 2.1 AA on ivory.
- Burnt-orange text is at least 4.5:1 on ivory; brighter orange is limited to
  the large non-text arrow.
- Titles and descriptions carry the evidence boundary for non-visual readers.
- The SVGs contain no animation. The public surface therefore introduces no
  motion or reduced-motion exception.

## Anti-slop decisions

No gradients, glowing orbs, glass panels, bento grids, stock imagery,
testimonials, fake metrics, standard icon-plus-wordmark logo, or copied venture
branding are used. The rail encodes a real product relationship rather than
serving as filler. The generated child design remains venture-owned and must not
inherit this Core identity as its final product UI.

## Evidence boundary

The current assets are source-controlled and locally rendered. GitHub social
preview upload remains a documented manual action, and no asset claims a live
provider URL, customer, demand result, or benchmark result.

## Assumptions

- GitHub continues to render repository SVG images responsively within README
  content.
- System font fallbacks preserve the intended sans/mono hierarchy without a
  network font request.

## Unresolved questions

- The final social-preview raster and crop remain unverified until the source is
  uploaded manually in GitHub repository settings.

## Related documents

- [Venture design template](DESIGN.md)
- [Product Truth](../product/PRODUCT_TRUTH.md)
- [GitHub social-preview step](../public/GITHUB_SOCIAL_PREVIEW.md)
- [Hero source](../assets/venture-harness-hero.svg)
- [Social-preview source](../assets/venture-harness-social-preview.svg)
