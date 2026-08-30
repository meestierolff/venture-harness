# GitHub social preview

- Status: source asset ready; manual upload not yet verified
- Source: `docs/assets/venture-harness-social-preview.svg`
- Required output: PNG, 1280 × 640, under 1 MB

The repository contains a solid-background SVG source because GitHub's social
preview uploader accepts PNG, JPG, or GIF rather than SVG. Export the source to
PNG without changing its 2:1 canvas, then:

1. Open the Venture Harness repository on GitHub.
2. Select **Settings**.
3. Find **Social preview** and select **Edit**.
4. Select **Upload an image…** and choose the exported 1280 × 640 PNG.
5. Reload the repository settings and confirm the preview image is displayed.

Do not mark the preview uploaded until that final read-back succeeds. These
steps and dimensions follow GitHub's official guidance:
https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview
