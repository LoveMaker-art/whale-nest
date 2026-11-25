import assert from 'node:assert/strict';

// The official bridge returns the newest bounded page and a cursor for older events.
export async function readBridgeHistory(client, sessionId) {
  const pages = [];
  let beforeSeq, header;
  for (;;) {
    const page = await client.request('history', { sessionId, beforeSeq });
    header ??= page.header;
    pages.push(page.events);
    if (page.nextBeforeSeq === null) return { header, events: pages.reverse().flat() };
    assert.ok(Number.isSafeInteger(page.nextBeforeSeq) && page.nextBeforeSeq === page.events[0]?.seq
      && (beforeSeq === undefined || page.nextBeforeSeq < beforeSeq), 'Invalid history page cursor');
    beforeSeq = page.nextBeforeSeq;
  }
}
