/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {ReactStore, StoreVersion} from 'shared/ReactTypes';
import type {FiberRoot} from './ReactInternalTypes';
import type {Lane, Lanes} from './ReactFiberLane';
import {
  peekEntangledActionLane,
  peekEntangledActionThenable,
} from './ReactFiberAsyncAction';

import {
  NoLane,
  NoLanes,
  SyncLane,
  includesSomeLane,
  intersectLanes,
  markRootEntangled,
  mergeLanes,
} from './ReactFiberLane';

// Stores with a root that has not committed a Transition toward their latest
// state. Held only until those roots commit.
const storesWithPendingRoots: Set<ReactStore<any, any>> = new Set();

// While a Transition is pending, a root rendering it reads the latest state,
// a root that committed it reads the latest state, and any other root reads
// the state from before it.
export function getStoreVersion<S, A>(
  store: ReactStore<S, A>,
  root: FiberRoot,
  lanes: Lanes,
): StoreVersion<S> {
  const head = store._head;
  const sync = store._sync;
  if (sync === head) {
    return head;
  }
  const pendingLanes = store._roots.get(root);
  if (pendingLanes === undefined) {
    return sync;
  }
  if (pendingLanes === NoLanes || includesSomeLane(lanes, pendingLanes)) {
    return head;
  }
  const version = store._rootVersions.get(root);
  return version === undefined ? sync : version;
}

export function getPendingStoreLanes<S, A>(
  store: ReactStore<S, A>,
  root: FiberRoot,
): Lanes {
  const pendingLanes = store._roots.get(root);
  return pendingLanes === undefined
    ? NoLanes
    : intersectLanes(root.pendingLanes, pendingLanes);
}

export function markStoreRootBehind<S, A>(
  store: ReactStore<S, A>,
  root: FiberRoot,
  lane: Lane,
): void {
  const pendingLanes = store._roots.get(root);
  if (pendingLanes === undefined || pendingLanes === NoLanes) {
    store._roots.set(root, lane);
    store._rootsBehind++;
    storesWithPendingRoots.add(store);
  } else {
    store._roots.set(root, mergeLanes(pendingLanes, lane));
  }
}

// Stores dispatched to inside a Transition during the current event. Roots are
// marked when the event's work is scheduled, after every Transition scope in
// the event has finished, including nested and throwing ones.
let pendingTransitionStores: Set<ReactStore<any, any>> | null = null;

export function queueTransitionStores(stores: Set<ReactStore<any, any>>): void {
  if (pendingTransitionStores === null) {
    pendingTransitionStores = new Set();
  }
  const pending = pendingTransitionStores;
  stores.forEach(store => {
    pending.add(store);
  });
}

// A root that scheduled work at the event's Transition lane renders the stores'
// latest state with that work, even if nothing in it read the stores yet.
export function markTransitionStoreRoots(
  firstRoot: FiberRoot | null,
  transitionLane: Lane,
): void {
  const stores = pendingTransitionStores;
  if (stores === null) {
    return;
  }
  pendingTransitionStores = null;
  stores.forEach(store => {
    store._isTransitionQueued = false;
    if (transitionLane !== NoLane) {
      let root = firstRoot;
      while (root !== null) {
        if (includesSomeLane(root.pendingLanes, transitionLane)) {
          const storeLanes = store._roots.get(root);
          markStoreRootBehind(store, root, transitionLane);
          if (storeLanes !== undefined && storeLanes !== NoLanes) {
            // Like entangleTransitionUpdate for a hook queue: a store is one
            // queue, so its pending Transitions in a root render together.
            markRootEntangled(
              root,
              mergeLanes(
                intersectLanes(storeLanes, root.pendingLanes),
                transitionLane,
              ),
            );
          }
        }
        root = root.next;
      }
    }
    if (
      transitionLane !== NoLane &&
      transitionLane === peekEntangledActionLane()
    ) {
      const action = peekEntangledActionThenable();
      if (action !== null && store._pendingAction !== action) {
        store._pendingAction = action;
        const settle = () => {
          if (store._pendingAction === action) {
            store._pendingAction = null;
            finishStoreRoots(store);
          }
        };
        action.then(settle, settle);
      }
    }
    if (store._rootsBehind === 0 && store._pendingAction === null) {
      store._sync = store._head;
      store._roots.clear();
      store._rootVersions.clear();
    }
  });
}

// A store's state lives above every root, so a render that includes an async
// Action's updates to a store waits for the Action at the root, like an update
// to the root itself does.
export function suspendIfRootReadsStoreAction(
  root: FiberRoot,
  lanes: Lanes,
): void {
  if (storesWithPendingRoots.size === 0) {
    return;
  }
  const actionLane = peekEntangledActionLane();
  const action = peekEntangledActionThenable();
  if (action === null || !includesSomeLane(lanes, actionLane)) {
    return;
  }
  const stores = Array.from(storesWithPendingRoots);
  for (let i = 0; i < stores.length; i++) {
    const store = stores[i];
    const pendingLanes = store._roots.get(root);
    if (
      store._pendingAction === action &&
      pendingLanes !== undefined &&
      includesSomeLane(pendingLanes, actionLane)
    ) {
      // TODO: Instead of the throwing the thenable directly, throw a
      // special object like `use` does so we can detect if it's captured
      // by userspace.
      throw action;
    }
  }
}

// Called after a root commits.
export function commitStoreRoots(root: FiberRoot): void {
  storesWithPendingRoots.forEach(finishStoreRoots);
}

// A root has committed a store's Transition once the lanes it rendered it at
// are no longer pending. A Transition in an async Action is not finished until
// the Action is, because the Action can dispatch again at the same lane. Once
// every root has committed, the state on screen is the latest state again.
function finishStoreRoots<S, A>(store: ReactStore<S, A>): void {
  if (store._pendingAction !== null) {
    return;
  }
  store._roots.forEach((pendingLanes, key) => {
    const root: FiberRoot = key as any;
    if (
      pendingLanes !== NoLanes &&
      !includesSomeLane(root.pendingLanes, pendingLanes)
    ) {
      store._roots.set(root, NoLanes);
      store._rootsBehind--;
      if (!store._isTransitionQueued) {
        // The root committed every Transition dispatched so far.
        store._rootVersions.set(root, store._head);
      }
    }
  });
  if (store._rootsBehind === 0 && !store._isTransitionQueued) {
    storesWithPendingRoots.delete(store);
    store._roots.clear();
    store._rootVersions.clear();
    if (store._sync !== store._head) {
      store._sync = store._head;
      // Readers in roots that did not render the Transition catch up to it.
      const readers = Array.from(store._readers);
      for (let i = 0; i < readers.length; i++) {
        readers[i](null, SyncLane);
      }
    }
  }
}
