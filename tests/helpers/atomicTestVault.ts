/** In-memory Obsidian adapter: process serializes read/transform/write per vault.
 * Production requires the native Vault.process implementation. */
const queues = new WeakMap<object, Promise<unknown>>();
export async function processTestVaultFile(vault: {
  read(file: any): Promise<string>;
  modify(file: any, content: string): Promise<void>;
}, file: any, transform: (content: string) => string): Promise<string> {
  const write = (queues.get(vault) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const content = transform(await vault.read(file));
    await vault.modify(file, content);
    return content;
  });
  queues.set(vault, write);
  return write;
}
