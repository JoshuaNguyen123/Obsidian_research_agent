export async function mapWithBoundedConcurrency<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  mapper: (value: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new RangeError("concurrency must be a positive safe integer.");
  }
  if (values.length === 0) return [];

  const results = new Array<Output>(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, values.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}
