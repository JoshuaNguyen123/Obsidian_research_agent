/**
 * Guards asynchronous DOM rendering so an older render can never replace a
 * newer streamed value. Targets are weakly held because chat rows are capped
 * and removed over long-running sessions.
 */
export class LatestRenderGate<TTarget extends object> {
  private sequence = 0;
  private readonly revisions = new WeakMap<TTarget, number>();

  begin(target: TTarget): number {
    const revision = ++this.sequence;
    this.revisions.set(target, revision);
    return revision;
  }

  invalidate(target: TTarget): void {
    this.revisions.set(target, ++this.sequence);
  }

  isCurrent(target: TTarget, revision: number): boolean {
    return this.revisions.get(target) === revision;
  }
}
