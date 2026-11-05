type MarkerStore = Pick<Storage, 'getItem'|'setItem'|'removeItem'>;

// Store only the random operation key, never an address, order contents or a token.
// The marker survives closing/reopening the panel in the same browser tab.
export function createDeliveryAttempt(store:MarkerStore,projectKey:string,orderId:string,newKey:()=>string=()=>`rw-${crypto.randomUUID()}`) {
  const storageKey=`rosewood-mc:pending-delivery:${projectKey}:${orderId}`;
  const persisted=store.getItem(storageKey);
  const attempt={key:persisted || newKey(),pending:Boolean(persisted),
    begin(){store.setItem(storageKey,attempt.key);attempt.pending=true;},
    complete(){store.removeItem(storageKey);attempt.key=newKey();attempt.pending=false;},
  };
  return attempt;
}
