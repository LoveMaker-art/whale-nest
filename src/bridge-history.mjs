import assert from 'node:assert/strict';

// Optional paging retains the original full-history contract for older callers.
export function historyPage(snapshot, params) {
  if (params.afterSeq === undefined) return snapshot;
  assert.ok(Number.isSafeInteger(params.afterSeq) && params.afterSeq >= -1, 'Invalid history cursor');
  const pending = snapshot.events.filter(e => e.seq > params.afterSeq), events = [];
  let bytes = Buffer.byteLength(JSON.stringify(snapshot.header)) + 1024;
  for (const event of pending) {
    const size = Buffer.byteLength(JSON.stringify(event)) + 1;
    if (events.length && (bytes + size > 700_000 || events.length >= 128)) break;
    assert.ok(bytes + size < 1_040_000, 'One native history event exceeds the Bridge frame limit');
    events.push(event); bytes += size;
  }
  return { header: snapshot.header, events, nextSeq: events.at(-1)?.seq ?? params.afterSeq, more: events.length < pending.length };
}

export async function readBridgeHistory(client, sessionId) {
  const events = []; let afterSeq = -1, header;
  for (;;) {
    const page = await client.request('history', { sessionId, afterSeq });
    header ??= page.header;
    for (const event of page.events) {
      assert.ok(Number.isSafeInteger(event.seq) && event.seq > afterSeq, 'History page did not advance');
      events.push(event); afterSeq = event.seq;
    }
    if (!page.more) return { header, events };
    assert.equal(page.nextSeq, afterSeq, 'Invalid history page cursor');
    assert.ok(page.events.length, 'Empty nonterminal history page');
  }
}
