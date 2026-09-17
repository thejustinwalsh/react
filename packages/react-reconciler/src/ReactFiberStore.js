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
  NoLane,
  NoLanes,
  SyncLane,
  includesSomeLane,
  intersectLanes,
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
  return pendingLanes === NoLanes || includesSomeLane(lanes, pendingLanes)
    ? head
    : sync;
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

function markStoreRootBehind<S, A>(
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
    if (transitionLane !== NoLane) {
      let root = firstRoot;
      while (root !== null) {
        if (includesSomeLane(root.pendingLanes, transitionLane)) {
          markStoreRootBehind(store, root, transitionLane);
        }
        root = root.next;
      }
    }
    if (store._rootsBehind === 0) {
      store._sync = store._head;
      store._roots.clear();
    }
  });
}

// Called after a root commits. Once every root that rendered a store's
// Transition has committed it, the state on screen is the latest state again.
export function commitStoreRoots(root: FiberRoot): void {
  storesWithPendingRoots.forEach(store => {
    const pendingLanes = store._roots.get(root);
    if (
      pendingLanes !== undefined &&
      pendingLanes !== NoLanes &&
      !includesSomeLane(root.pendingLanes, pendingLanes)
    ) {
      store._roots.set(root, NoLanes);
      store._rootsBehind--;
    }
    if (store._rootsBehind === 0) {
      storesWithPendingRoots.delete(store);
      store._roots.clear();
      if (store._sync !== store._head) {
        store._sync = store._head;
        // Readers in roots that did not render the Transition catch up to it.
        const readers = Array.from(store._readers);
        for (let i = 0; i < readers.length; i++) {
          readers[i](false, SyncLane);
        }
      }
    }
  });
}
