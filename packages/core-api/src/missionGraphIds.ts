/**
 * Converts a host run identifier into the strict stable-id form accepted by
 * MissionGraphV3. Prepared actions retain the original run identifier, so
 * graph/run binding checks must compare against this canonical projection.
 */
export function canonicalMissionGraphId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .slice(0, 128)
    // Slicing a long identifier can expose a separator at the boundary.
    .replace(/[^a-z0-9]+$/g, "");
  return normalized || "mission";
}
