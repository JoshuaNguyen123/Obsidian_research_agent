export interface ConnectedRegistryElement {
  readonly isConnected: boolean;
}

/**
 * Returns a registry entry only while it still belongs to a mounted DOM tree.
 * ItemView instances can outlive their rendered elements, so disconnected
 * entries must be evicted before callers use registry size for row bounds.
 */
export function getConnectedRegistryElement<
  Key,
  Element extends ConnectedRegistryElement,
>(registry: Map<Key, Element>, key: Key): Element | null {
  const existing = registry.get(key);
  if (!existing) {
    return null;
  }
  if (existing.isConnected) {
    return existing;
  }
  registry.delete(key);
  return null;
}
