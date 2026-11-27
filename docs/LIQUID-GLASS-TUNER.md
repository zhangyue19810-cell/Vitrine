# Liquid Glass tuner

Standalone parameter tuner for the Vitrine glass material. The filter graph is
adapted from Archis Vaze's MIT-licensed Liquid Glass implementation.

Open `liquid-glass-tuner.html` in Chrome / Edge. The delivered copy lives at:

```
/storage/emulated/0/Vitrine/liquid-glass-tuner.html
```

It uses `liquid-glass-main/backgrounds/*.jpg` for the four preset wallpapers;
you can also load any local image from the bottom-left picker.

Useful controls:

- Glass Thickness / Bezel Width / Refractive Index / Scale Ratio / corner radius
- Blur (set to 0 to remove the gaussian blur)
- Specular Opacity / Specular Saturation
- Tint color and opacity (0% = fully clear)
- Inner shadow color / blur / spread
- Outer shadow blur

The preview is built from real Vitrine-style surfaces: a large instance panel,
chips, buttons, a nav pill, a field and a round action button. Each surface gets
its own displacement map generated at its current pixel size, so the exported
numbers remain meaningful when the layout changes.

Press **复制参数 JSON** after tuning and send that JSON back. The app-side
implementation can then be updated with the same numbers. For a quick baseline,
the **当前 Vitrine** preset is:

```json
{
  "glassThickness": 81,
  "bezelWidth": 50,
  "refractiveIndex": 1.98,
  "scaleRatio": 2,
  "cornerRadius": 46,
  "blur": 0,
  "specularOpacity": 0.18,
  "specularSaturation": 4,
  "tint": { "color": "#ffffff", "opacityPercent": 0 },
  "innerShadow": { "color": "#ffffff", "blur": 20, "spread": -5 },
  "outerShadow": { "color": "#000000", "blur": 24, "opacity": 0.18 }
}
```

Firefox cannot composite an SVG filter as `backdrop-filter`, so the tuner shows
a blur fallback there. Use Chromium for the real refracted edges.
