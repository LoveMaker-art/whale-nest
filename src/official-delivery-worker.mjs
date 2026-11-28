import {executeOfficialDelivery} from './official-delivery.mjs';

// A detached, short-lived owner of one already persisted delivery. It never
// retries a journal that has progressed beyond prepared.
await executeOfficialDelivery(process.argv[2]);
