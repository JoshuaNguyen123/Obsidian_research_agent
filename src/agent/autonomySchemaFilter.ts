/**
 * Filter model tool schemas by Soft/Bound/Hard max class.
 */

import type { ModelToolDefinition } from "../model/types";
import {
  filterToolNamesByMaxEffectClass,
  type AutonomyEffectClass,
} from "./autonomyEffectClass";

export function filterSchemasByMaxEffectClass(
  schemas: readonly ModelToolDefinition[],
  max: AutonomyEffectClass,
): ModelToolDefinition[] {
  const allowed = new Set(
    filterToolNamesByMaxEffectClass(
      schemas.map((schema) => schema.function.name),
      max,
    ),
  );
  return schemas.filter((schema) => allowed.has(schema.function.name));
}
