import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** Preserve the attempt before contacting a renderer that may already be dead.
 * Callers select the evidence fields; never pass settings or model thinking. */
export async function preserveFailureEvidence(input: {
  file: string;
  metadata: Record<string, unknown>;
  read: () => Promise<unknown>;
  timeoutMs?: number;
}): Promise<void> {
  const record = {
    version: 1,
    recordedAt: new Date().toISOString(),
    ...input.metadata,
    readStatus: "started",
    evidence: null as unknown,
  };
  const save = async () => {
    await mkdir(path.dirname(input.file), { recursive: true });
    const temporary = `${input.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await rename(temporary, input.file);
  };
  await save();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve().then(input.read).then((evidence) => ({ evidence })),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Evidence read timed out")), input.timeoutMs ?? 3_000);
      }),
    ]);
    record.evidence = result.evidence;
    record.readStatus = result.evidence === null ? "unavailable" : "captured";
  } catch {
    record.readStatus = "unavailable";
  } finally {
    clearTimeout(timer);
    await save();
  }
}
