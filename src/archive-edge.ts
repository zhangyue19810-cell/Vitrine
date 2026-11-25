/**
 * Thick-glass rim for the archive covers.
 *
 * The liquid-glass shader in Lumina UI gives its slabs a dark outer contour,
 * a bright inner bevel and a warm lit edge. The archive is a closed 3D model,
 * so the same read is reproduced from the view-space normal: Fresnel darkens
 * the silhouette like a thick refractive wall, while the lit side receives a
 * narrow champagne bevel. It runs once in the existing PBR shader, adding no
 * draw call or extra material pass.
 */
export function archiveEdgeFragment(source: string): string {
  return source.replace(
    "#include <opaque_fragment>",
    /* glsl */ `
      float archiveFacing = clamp(abs(dot(normalize(normal), normalize(vViewPosition))), 0.0, 1.0);
      float archiveRim = pow(1.0 - archiveFacing, 2.35);
      vec3 archiveLight = normalize(vec3(-0.42, 0.74, 0.52));
      float archiveLit = clamp(dot(normalize(normal), archiveLight), 0.0, 1.0);
      vec3 archiveRimColor = mix(vec3(0.16, 0.075, 0.018), vec3(1.0, 0.77, 0.38), archiveLit);
      // A thick wall swallows light near the silhouette, then a hairline metal
      // bevel catches the studio key. The bright line stays inside the dark rim.
      outgoingLight = mix(outgoingLight, outgoingLight * 0.30, archiveRim * 0.78);
      outgoingLight += archiveRimColor * archiveRim * (0.055 + 0.115 * archiveLit);
      #include <opaque_fragment>
    `,
  );
}
