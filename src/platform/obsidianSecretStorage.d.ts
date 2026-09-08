import "obsidian";

/**
 * Members of Obsidian's native SecretStorage that its published `obsidian.d.ts`
 * does not declare.
 *
 * `obsidian.d.ts` (1.11.4) ships only `setSecret`, `getSecret` and
 * `listSecrets`, so every caller of anything else was type-safe only by way of
 * an `any` — which is how the harness came to call `deleteSecret` with nothing
 * checking the name or the arity. The method is real: the shipped
 * `obsidian.asar` defines it as
 * `deleteSecret(id) { return !!Object.hasOwn(this.secrets, id) && (delete this.secrets[id], this.adapter?.save(...), true) }`
 * and the app's own settings UI calls it for its return value.
 *
 * It is declared optional because the declaration file it augments is the
 * contract for every Obsidian build the plugin runs against, not just the one
 * installed here; a build without the method must degrade (clear the value)
 * rather than throw, so every call site probes for it first.
 */
declare module "obsidian" {
  interface SecretStorage {
    /**
     * Delete a secret outright, rather than leaving the empty-value tombstone
     * a `setSecret(id, "")` leaves behind (263 of those on 2026-09-07).
     * Returns whether the id existed. Like every other SecretStorage write it
     * lands in Chromium DOMStorage, so a commit still has to be asked for.
     */
    deleteSecret?(id: string): boolean;
  }
}
