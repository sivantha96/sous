# Lens: correctness

Wrong results and crashes. Edge cases: empty, zero, one, last item, null, duplicates, rounding, time zones, retries, concurrent requests. Errors swallowed or turned into success. Async ordering, missing awaits, a missing return after a response. A fix made in one caller while the shared function stays broken. A changed signature or return value whose callers were not updated.
