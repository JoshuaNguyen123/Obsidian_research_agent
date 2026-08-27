import type { AgentRunMetricEvent } from "../AgentRunner";

/**
 * The value a metric event is actually about, and how to say it.
 *
 * Not every metric is a duration. A count rendered through `durationMs`
 * displays as "0ms" — a number wearing the wrong unit, which is a claim about
 * kind rather than about value, and the sort of thing a reader believes
 * precisely because it looks precise.
 *
 * The identity half matters more than the display half. The trace id embedded
 * `durationMs` directly, so two non-duration events in the same step differed
 * only by a constant 0 and collided. Deriving id and message from the same
 * salient value keeps an id as distinct as the number it is named for.
 *
 * This is the correct seat for any future non-duration metric: add a branch
 * here rather than borrowing `durationMs` to carry it. A count silently read as
 * milliseconds downstream is a worse bug than a label that reads "0ms".
 */
export function describeMetricEventValue(event: AgentRunMetricEvent): {
  token: string;
  rendered: string;
} {
  if (typeof event.decodeMs === "number") {
    const rows =
      typeof event.rowsScored === "number" ? `, ${event.rowsScored} rows` : "";
    return {
      token: `${event.durationMs}d${event.decodeMs}`,
      rendered: `${event.durationMs}ms (decode ${event.decodeMs}ms${rows})`,
    };
  }
  return {
    token: String(event.durationMs),
    rendered: `${event.durationMs}ms`,
  };
}
