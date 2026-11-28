import {hash} from './routing.mjs';

/** Only Core's terminal proof of zero executions permits another submission.
 * Pending, missing, failed and indeterminate receipts never authorize a retry. */
export function retryUnexecutedLivewareOperation(operation,receipt){
  if((receipt?.status??receipt?.state)!=='expired'||receipt.unexecuted!==true)return null;
  const attempts=operation.attempts??[];
  if(attempts.length>=2)return null;
  return {state:'unissued',requestId:'whalenest-liveware-recovery-'+hash(operation.requestId),
    attempts:[...attempts,{requestId:operation.requestId,state:'expired',unexecuted:true}]};
}
