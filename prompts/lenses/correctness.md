# Lens: correctness

Wrong results and crashes. Edge cases: empty, zero, one, last item, null, duplicates, rounding, time zones, retries, concurrent requests. Errors swallowed or turned into success. Async ordering, missing awaits, a missing return after a response. A fix made in one caller while the shared function stays broken. A changed signature or return value whose callers were not updated.

Runtime and data lifecycle, checked one by one:
- **Data written, read and deleted.** A new field written but never read, or read before any writer sets it; an old field still read after its writer is removed; data deleted while something still points at it; a soft delete that queries forget to filter.
- **Return contracts.** A function that now returns null, undefined, an empty list or a different shape, and a caller that doesn't handle it.
- **Fallbacks.** A default, catch or `??` that turns a real failure into a plausible wrong value.
- **Order and time.** Two writes that can interleave; a check, then an act, with a gap between them; a timestamp in the wrong time zone or precision.
- **Idempotency.** A handler, job or webhook that does harm when it runs twice.
- **Limits.** A list, queue, cache or retry that grows without bound.

Only these categories; anything else belongs to another lens.
