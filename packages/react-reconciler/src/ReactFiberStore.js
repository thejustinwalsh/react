/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {
  ReactStore,
  StoreRenderer,
  StoreUpdate,
  Thenable,
} from 'shared/ReactTypes';
import type {Fiber, FiberRoot} from './ReactInternalTypes';
import type {Lane, Lanes} from './ReactFiberLane';

import is from 'shared/objectIs';
import {
  NoLane,
  NoLanes,
  SyncLane,
  includesSomeLane,
  isTransitionLane,
  markRootEntangled,
  mergeLanes,
} from './ReactFiberLane';
import {
  peekEntangledActionLane,
  peekEntangledActionThenable,
} from './ReactFiberAsyncAction';
import {eventPriorityToLane} from './ReactEventPriorities';
import {resolveUpdatePriority} from './ReactFiberConfig';
import {requestCurrentTransition} from './ReactFiberTransition';
import {
  firstScheduledRoot,
  requestTransitionLane,
} from './ReactFiberRootScheduler';
import {enqueueConcurrentRenderForLane} from './ReactFiberConcurrentUpdates';
import {
  isInvalidExecutionContextForEventFunction,
  scheduleUpdateOnFiber,
} from './ReactFiberWorkLoop';
import {startUpdateTimerByLane} from './ReactProfilerTimer';
import {ConcurrentMode, NoMode, StrictLegacyMode} from './ReactTypeOfMode';

// An action that not every root with a reader has committed.
type StoreEntry<S, A> = {
  action: A,
  lane: Lane,
  // The store's state after this action.
  state: S,
  // Roots that had work pending in the action's lane when it was dispatched,
  // and wait to show it until they commit it.
  pendingRoots: Set<FiberRoot>,
  committedRoots: Set<FiberRoot>,
};

export type StoreReader<S, T> = {
  store: ReactStore<S, mixed>,
  root: FiberRoot,
  fiber: Fiber,
  // What the reader committed. Published before layout effects, so an action
  // dispatched from one is compared with it.
  selector: (state: S, previous: T | void) => T,
  value: T,
};

// A renderer's view of a store. Until a root commits an action, it renders the
// action like an update to state above the root, in the lane it was dispatched
// in.
type StoreInternals<S, A> = {
  store: ReactStore<S, A>,
  // The state every root with a reader has committed.
  baseState: S,
  entries: Array<StoreEntry<S, A>>,
  readers: Set<StoreReader<S, any>>,
  // The number of readers in each root.
  roots: Map<FiberRoot, number>,
  // The unfinished async Action the store has actions in.
  action: Thenable<void> | null,
  strictReaders: number, // DEV-only
  // Incremented whenever what a root reads from the log can change.
  version: number,
  // The last read of the log, and what it was read for. Every reader in a root
  // reads the same.
  cachedRoot: FiberRoot | null,
  cachedLanes: Lanes,
  cachedActionLane: Lane,
  cachedVersion: number,
  cachedState: S,
  cachedSkippedLanes: Lanes,
};

const storeInternals: WeakMap<
  ReactStore<any, any>,
  StoreInternals<any, any>,
> = new WeakMap();

// Updates this renderer was given when they were dispatched in a Transition.
const receivedStoreUpdates: WeakSet<StoreUpdate<any, any>> = new WeakSet();

// The stores each root has a reader of.
const rootStores: Map<FiberRoot, Set<StoreInternals<any, any>>> = new Map();

function getStoreInternals<S, A>(
  store: ReactStore<S, A>,
): StoreInternals<S, A> {
  const existingInternals = storeInternals.get(store);
  if (existingInternals !== undefined) {
    return existingInternals;
  }
  const internals: StoreInternals<S, A> = {
    store,
    baseState: store.getState(),
    entries: [],
    readers: new Set(),
    roots: new Map(),
    action: null,
    strictReaders: 0,
    version: 0,
    cachedRoot: null,
    cachedLanes: NoLanes,
    cachedActionLane: NoLane,
    cachedVersion: -1,
    cachedState: store.getState(),
    cachedSkippedLanes: NoLanes,
  };
  storeInternals.set(store, internals);
  return internals;
}

function isStoreEntryVisible<S, A>(
  entry: StoreEntry<S, A>,
  root: FiberRoot,
  lanes: Lanes,
): boolean {
  if (entry.committedRoots.has(root) || includesSomeLane(lanes, entry.lane)) {
    return true;
  }
  // A root that had no work pending for an action has nothing to commit with
  // it, so it already shows the action, unless the action is part of an
  // unfinished async Action.
  return (
    !entry.pendingRoots.has(root) && entry.lane !== peekEntangledActionLane()
  );
}

// The state of a store a root renders at these lanes.
function readStoreEntries<S, A>(
  internals: StoreInternals<S, A>,
  root: FiberRoot,
  lanes: Lanes,
): void {
  const actionLane = peekEntangledActionLane();
  if (
    internals.cachedVersion === internals.version &&
    internals.cachedRoot === root &&
    internals.cachedLanes === lanes &&
    internals.cachedActionLane === actionLane
  ) {
    return;
  }
  const store = internals.store;
  const entries = internals.entries;
  let state = internals.baseState;
  let skippedLanes = NoLanes;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!isStoreEntryVisible(entry, root, lanes)) {
      skippedLanes = mergeLanes(skippedLanes, entry.lane);
    } else if (skippedLanes !== NoLanes) {
      // Rebased onto the actions this render shows.
      state = store._reducer(state, entry.action);
    } else {
      state = entry.state;
    }
  }
  internals.cachedVersion = internals.version;
  internals.cachedRoot = root;
  internals.cachedLanes = lanes;
  internals.cachedActionLane = actionLane;
  internals.cachedState = state;
  internals.cachedSkippedLanes = skippedLanes;
}

// The state of a store a root renders at these lanes.
export function readStoreState<S, A>(
  store: ReactStore<S, A>,
  root: FiberRoot,
  lanes: Lanes,
): S {
  const internals = storeInternals.get(store);
  if (internals === undefined || internals.entries.length === 0) {
    return store.getState();
  }
  readStoreEntries(internals, root, lanes);
  return internals.cachedState;
}

// The lanes of actions a render at these lanes leaves out, which the root still
// has to render.
export function getSkippedStoreLanes<S, A>(
  store: ReactStore<S, A>,
  root: FiberRoot,
  lanes: Lanes,
): Lanes {
  const internals = storeInternals.get(store);
  if (internals === undefined || internals.entries.length === 0) {
    return NoLanes;
  }
  readStoreEntries(internals, root, lanes);
  return internals.cachedSkippedLanes;
}

function requestStoreUpdateLane(): Lane {
  const transition = requestCurrentTransition();
  if (transition !== null) {
    return requestTransitionLane(transition);
  }
  return eventPriorityToLane(resolveUpdatePriority());
}

function isSameSelection<S, T>(reader: StoreReader<S, T>, state: S): boolean {
  try {
    return is(reader.selector(state, reader.value), reader.value);
  } catch (error) {
    // Render throws it.
    return false;
  }
}

const storeRenderer: StoreRenderer = {
  validateStoreUpdate(): void {
    if (isInvalidExecutionContextForEventFunction()) {
      throw new Error(
        'Cannot dispatch to a store while rendering. Dispatch from an event ' +
          'handler or an effect instead.',
      );
    }
  },
  receiveStoreUpdate(update: StoreUpdate<any, any>): void {
    const internals = storeInternals.get(update.store);
    if (internals !== undefined) {
      dispatchToStoreReaders(internals, update.action, update.state);
      if (requestCurrentTransition() !== null) {
        receivedStoreUpdates.add(update);
      }
    }
  },
};

function dispatchToStoreReaders<S, A>(
  internals: StoreInternals<S, A>,
  action: A,
  state: S,
): void {
  const store = internals.store;
  const entries = internals.entries;
  if (__DEV__ && internals.strictReaders > 0) {
    // Like StrictMode does for useReducer, surface an impure reducer by
    // calling it twice.
    store._reducer(
      entries.length > 0
        ? entries[entries.length - 1].state
        : internals.baseState,
      action,
    );
  }
  const lane = requestStoreUpdateLane();
  const entry: StoreEntry<S, A> = {
    action,
    lane,
    state,
    pendingRoots: new Set(),
    committedRoots: new Set(),
  };
  entries.push(entry);
  internals.version++;

  if (isTransitionLane(lane)) {
    internals.roots.forEach((count, root) => {
      const pendingLanes = getPendingTransitionLanes(internals, root);
      if (pendingLanes !== NoLanes) {
        // A store is one queue, so its pending Transitions in a root render
        // together, like updates to one hook, even when no reader renders
        // this one.
        const hostRoot = root.current;
        const scheduledRoot = enqueueConcurrentRenderForLane(hostRoot, lane);
        if (scheduledRoot !== null) {
          scheduleUpdateOnFiber(scheduledRoot, hostRoot, lane);
        }
        markRootEntangled(root, mergeLanes(pendingLanes, lane));
      }
    });
  }

  internals.readers.forEach(reader => {
    const fiber = reader.fiber;
    if (
      (fiber.mode & ConcurrentMode) !== NoMode &&
      isSameSelection(reader, entry.state) &&
      isSameSelection(reader, readStoreState(store, reader.root, NoLanes))
    ) {
      // Rendered with or without this action, the reader shows the same.
      return;
    }
    // A legacy root renders every update synchronously.
    const readerLane =
      (fiber.mode & ConcurrentMode) === NoMode ? SyncLane : lane;
    const root = enqueueConcurrentRenderForLane(fiber, readerLane);
    if (root !== null) {
      startUpdateTimerByLane(readerLane, 'store.dispatch()', fiber);
      scheduleUpdateOnFiber(root, fiber, readerLane);
    }
  });

  markStoreEntryPendingRoots(internals, entry);

  if (!isTransitionLane(lane)) {
    // Which roots a Transition schedules work on is known once its scope
    // finishes.
    compactStoreEntries(internals);
  }
}

function markStoreEntryPendingRoots<S, A>(
  internals: StoreInternals<S, A>,
  entry: StoreEntry<S, A>,
): void {
  internals.roots.forEach((readers, root) => {
    if (includesSomeLane(root.pendingLanes, entry.lane)) {
      entry.pendingRoots.add(root);
      internals.version++;
    }
  });
}

// The Transition lanes of actions a root has not committed and has work
// pending for, other than the last one.
function getPendingTransitionLanes<S, A>(
  internals: StoreInternals<S, A>,
  root: FiberRoot,
): Lanes {
  let lanes = NoLanes;
  const entries = internals.entries;
  for (let i = 0; i < entries.length - 1; i++) {
    const entry = entries[i];
    if (
      entry.pendingRoots.has(root) &&
      !entry.committedRoots.has(root) &&
      isTransitionLane(entry.lane) &&
      includesSomeLane(root.pendingLanes, entry.lane)
    ) {
      lanes = mergeLanes(lanes, entry.lane);
    }
  }
  return lanes;
}

// Forget the actions every root shows, and the roots that only waited on them.
function compactStoreEntries<S, A>(internals: StoreInternals<S, A>): void {
  const entries = internals.entries;
  let count = 0;
  while (
    count < entries.length &&
    isStoreEntryShownEverywhere(internals, entries[count])
  ) {
    count++;
  }
  if (count > 0) {
    internals.baseState = entries[count - 1].state;
    entries.splice(0, count);
    internals.version++;
  }
  internals.roots.forEach((readers, root) => {
    if (readers === 0 && !hasPendingStoreEntries(internals, root)) {
      removeStoreRoot(internals, root);
    }
  });
  if (internals.readers.size === 0 && entries.length === 0) {
    internals.store._renderers.delete(storeRenderer);
  }
}

function isStoreEntryShownEverywhere<S, A>(
  internals: StoreInternals<S, A>,
  entry: StoreEntry<S, A>,
): boolean {
  const roots = Array.from(internals.roots.keys());
  for (let i = 0; i < roots.length; i++) {
    if (!isStoreEntryVisible(entry, roots[i], NoLanes)) {
      return false;
    }
  }
  return true;
}

function hasPendingStoreEntries<S, A>(
  internals: StoreInternals<S, A>,
  root: FiberRoot,
): boolean {
  const entries = internals.entries;
  for (let i = 0; i < entries.length; i++) {
    if (!isStoreEntryVisible(entries[i], root, NoLanes)) {
      return true;
    }
  }
  return false;
}

function listenToStore<S, A>(internals: StoreInternals<S, A>): void {
  const store = internals.store;
  if (!store._renderers.has(storeRenderer)) {
    // Not listening, so the log is empty.
    internals.baseState = store.getState();
    store._renderers.add(storeRenderer);
  }
}

function addStoreRoot<S, A>(
  internals: StoreInternals<S, A>,
  root: FiberRoot,
  readers: number,
): void {
  internals.roots.set(root, (internals.roots.get(root) || 0) + readers);
  let stores = rootStores.get(root);
  if (stores === undefined) {
    stores = new Set();
    rootStores.set(root, stores);
  }
  stores.add(internals);
}

function removeStoreRoot<S, A>(
  internals: StoreInternals<S, A>,
  root: FiberRoot,
): void {
  internals.roots.delete(root);
  const entries = internals.entries;
  for (let i = 0; i < entries.length; i++) {
    entries[i].pendingRoots.delete(root);
    entries[i].committedRoots.delete(root);
  }
  const stores = rootStores.get(root);
  if (stores !== undefined) {
    stores.delete(internals);
    if (stores.size === 0) {
      rootStores.delete(root);
    }
  }
}

export function subscribeToStoreReader<S, T>(
  reader: StoreReader<S, T>,
): () => void {
  const root = reader.root;
  const internals = getStoreInternals(reader.store);
  listenToStore(internals);
  internals.readers.add(reader);
  addStoreRoot(internals, root, 1);
  const isStrict = __DEV__ && (reader.fiber.mode & StrictLegacyMode) !== NoMode;
  if (isStrict) {
    internals.strictReaders++;
  }
  return () => {
    if (isStrict) {
      internals.strictReaders--;
    }
    internals.readers.delete(reader);
    internals.roots.set(root, (internals.roots.get(root) || 0) - 1);
    compactStoreEntries(internals);
  };
}

// Called when a Transition's scope finishes. An update this renderer was not
// given, because it had no readers of the store, is shown by a root that
// renders the Transition, even if the root has no readers of the store yet.
export function finishStoreTransition(
  storeUpdates: Array<StoreUpdate<any, any>> | void,
  lane: Lane,
): void {
  if (storeUpdates === undefined) {
    return;
  }
  const stores: Set<StoreInternals<any, any>> = new Set();
  for (let i = 0; i < storeUpdates.length; i++) {
    const update = storeUpdates[i];
    const store = update.store;
    if (receivedStoreUpdates.has(update)) {
      const internals = storeInternals.get(store);
      if (internals !== undefined) {
        stores.add(internals);
      }
    } else if (lane !== NoLane) {
      const internals = getStoreInternals(store);
      if (!store._renderers.has(storeRenderer)) {
        store._renderers.add(storeRenderer);
        internals.baseState = update.previousState;
      }
      internals.entries.push({
        action: update.action,
        lane,
        state: update.state,
        pendingRoots: new Set(),
        committedRoots: new Set(),
      });
      internals.version++;
      stores.add(internals);
    }
  }
  const action = peekEntangledActionThenable();
  stores.forEach(internals => {
    if (
      action !== null &&
      lane === peekEntangledActionLane() &&
      internals.action !== action
    ) {
      internals.action = action;
      const onActionFinish = () => finishStoreAction(internals);
      action.then(onActionFinish, onActionFinish);
    }
    if (lane !== NoLane) {
      // A root the Transition scheduled work on after the action was
      // dispatched also waits to show it.
      let root = firstScheduledRoot;
      while (root !== null) {
        if (includesSomeLane(root.pendingLanes, lane)) {
          const entries = internals.entries;
          for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            if (entry.lane === lane && !entry.committedRoots.has(root)) {
              if (!internals.roots.has(root)) {
                addStoreRoot(internals, root, 0);
              }
              entry.pendingRoots.add(root);
              internals.version++;
            }
          }
        }
        root = root.next;
      }
    }
    compactStoreEntries(internals);
  });
}

// Called when an async Action the store has actions in finishes. A root that
// had no work pending for them shows them now.
function finishStoreAction<S, A>(internals: StoreInternals<S, A>): void {
  internals.action = null;
  internals.version++;
  internals.readers.forEach(reader => {
    if (didStoreReaderMissAction(reader)) {
      const fiber = reader.fiber;
      const root = enqueueConcurrentRenderForLane(fiber, SyncLane);
      if (root !== null) {
        scheduleUpdateOnFiber(root, fiber, SyncLane);
      }
    }
  });
  compactStoreEntries(internals);
}

// Whether a reader shows something other than what its root shows now,
// because it was not subscribed when an action was dispatched.
export function didStoreReaderMissAction<S, T>(
  reader: StoreReader<S, T>,
): boolean {
  return !isSameSelection(
    reader,
    readStoreState(reader.store, reader.root, NoLanes),
  );
}

// A store's state behaves as if it lives above each root, so a render that
// includes an async Action's actions waits for the Action at the root, like an
// update to the root itself does.
export function suspendIfRootReadsStoreAction(
  root: FiberRoot,
  lanes: Lanes,
): void {
  const stores = rootStores.get(root);
  if (stores === undefined) {
    return;
  }
  const action = peekEntangledActionThenable();
  const actionLane = peekEntangledActionLane();
  if (action === null || !includesSomeLane(lanes, actionLane)) {
    return;
  }
  stores.forEach(internals => {
    const entries = internals.entries;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.lane === actionLane && !entry.committedRoots.has(root)) {
        // TODO: Instead of throwing the thenable directly, throw a special
        // object like `use` does so we can detect if it's captured by
        // userspace.
        throw action;
      }
    }
  });
}

// Called when a root commits, before its effects run. The root has committed
// every action it has no work pending for.
export function commitStoreRoot(root: FiberRoot): void {
  const stores = rootStores.get(root);
  if (stores === undefined) {
    return;
  }
  stores.forEach(internals => {
    const entries = internals.entries;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (
        entry.pendingRoots.has(root) &&
        !entry.committedRoots.has(root) &&
        !includesSomeLane(root.pendingLanes, entry.lane) &&
        entry.lane !== peekEntangledActionLane()
      ) {
        entry.committedRoots.add(root);
        internals.version++;
      }
    }
    compactStoreEntries(internals);
  });
}
