/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {ReactStore, StoreUpdate, Thenable} from 'shared/ReactTypes';
import type {Fiber, FiberRoot, StoreDependency} from './ReactInternalTypes';
import type {Lane, Lanes} from './ReactFiberLane';
import type {Transition} from 'react/src/ReactStartTransition';

import is from 'shared/objectIs';
import ReactSharedInternals from 'shared/ReactSharedInternals';
import {enableStore} from 'shared/ReactFeatureFlags';
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
import {Update} from './ReactFiberFlags';
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
  // The Transition whose scope the action was dispatched in, until the scope
  // finishes.
  transition: Transition | null,
};

// A reader with nothing selected eagerly.
export const noEagerSelection: {...} = {};

export type StoreReader<S, T> = {
  store: ReactStore<S, mixed>,
  root: FiberRoot,
  fiber: Fiber,
  // What the reader committed. Published before layout effects, so an action
  // dispatched from one is compared with it.
  selector: (state: S, previous: T | void) => T,
  value: T,
  // The state the reader committed, so a check that nothing moved since costs
  // no call to the selector.
  state: S,
  // What the selector returned for a dispatched action, reused by the render
  // the dispatch schedules, like the eager state of a useState update.
  eagerState: S | typeof noEagerSelection,
  eagerValue: T | typeof noEagerSelection,
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
  // The number of actions whose Transition scope has not finished.
  transitions: number,
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

// The stores dispatched to in each Transition whose scope has not finished.
const transitionStores: WeakMap<
  Transition,
  Set<StoreInternals<any, any>>,
> = new WeakMap();

// The stores each root has a reader of.
const rootStores: Map<FiberRoot, Set<StoreInternals<any, any>>> = new Map();

function getStoreInternals<S, A>(
  store: ReactStore<S, A>,
  baseState: S,
): StoreInternals<S, A> {
  const existingInternals = storeInternals.get(store);
  if (existingInternals !== undefined) {
    return existingInternals;
  }
  const internals: StoreInternals<S, A> = {
    store,
    baseState,
    entries: [],
    readers: new Set(),
    roots: new Map(),
    action: null,
    transitions: 0,
    strictReaders: 0,
    version: 0,
    cachedRoot: null,
    cachedLanes: NoLanes,
    cachedActionLane: NoLane,
    cachedVersion: -1,
    cachedState: baseState,
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
  if (
    entry.pendingRoots.has(root) ||
    // Until the Transition's scope finishes, a root it has scheduled work on
    // may still render it.
    (entry.transition !== null &&
      includesSomeLane(root.pendingLanes, entry.lane))
  ) {
    return false;
  }
  // A root that had no work pending for an action has nothing to commit with
  // it, so it already shows the action, unless the action is part of an
  // unfinished async Action.
  return entry.lane !== peekEntangledActionLane();
}

// The state of a store a root renders at these lanes.
function readStoreEntries<S, A>(
  internals: StoreInternals<S, A>,
  root: FiberRoot,
  lanes: Lanes,
): void {
  const actionLane = peekEntangledActionLane();
  if (
    internals.transitions === 0 &&
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
    const selection = reader.selector(state, reader.value);
    reader.eagerState = state;
    reader.eagerValue = selection;
    return is(selection, reader.value);
  } catch (error) {
    // Render throws it.
    reader.eagerState = noEagerSelection;
    reader.eagerValue = noEagerSelection;
    return false;
  }
}

// What the selector returned when the action was dispatched, if the render
// reads the same state with the same selector. Selecting again would return
// the same thing.
export function getEagerStoreSelection<S, T>(
  reader: StoreReader<S, T>,
  state: S,
  selector: (state: S, previous: T | void) => T,
  previous: T | void,
): T | typeof noEagerSelection {
  const eagerValue = reader.eagerValue;
  if (
    eagerValue === noEagerSelection ||
    reader.selector !== selector ||
    reader.eagerState !== state ||
    previous !== reader.value
  ) {
    return noEagerSelection;
  }
  reader.eagerState = noEagerSelection;
  reader.eagerValue = noEagerSelection;
  return eagerValue as any;
}

function validateStoreUpdate(): void {
  if (isInvalidExecutionContextForEventFunction()) {
    throw new Error(
      'Cannot dispatch to a store while rendering. Dispatch from an event ' +
        'handler or an effect instead.',
    );
  }
}

function receiveStoreUpdate<S, A>(update: StoreUpdate<S, A>): void {
  const store = update.store;
  const transition = requestCurrentTransition();
  let internals = storeInternals.get(store);
  if (internals === undefined) {
    if (transition === null) {
      // Nothing in this renderer reads the store or waits on its actions.
      return;
    }
    // A reader may mount before the Transition commits.
    internals = getStoreInternals(store, update.previousState);
  }
  const entry = dispatchToStoreReaders(internals, update.action, update.state);
  if (transition !== null) {
    entry.transition = transition;
    internals.transitions++;
    let stores = transitionStores.get(transition);
    if (stores === undefined) {
      stores = new Set();
      transitionStores.set(transition, stores);
    }
    stores.add(internals);
  } else {
    compactStoreEntries(internals);
  }
}

if (enableStore) {
  // Every renderer receives every store update, and each renderer can reject
  // it before any of them applies it:
  //
  //   validate(A), validate(B), receive(B), receive(A)
  const prevOnStoreUpdate = ReactSharedInternals.U;
  ReactSharedInternals.U = function onStoreUpdateForReconciler(
    update: StoreUpdate<any, any>,
  ): void {
    validateStoreUpdate();
    if (prevOnStoreUpdate !== null) {
      prevOnStoreUpdate(update);
    }
    receiveStoreUpdate(update);
  };
}

function dispatchToStoreReaders<S, A>(
  internals: StoreInternals<S, A>,
  action: A,
  state: S,
): StoreEntry<S, A> {
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
    transition: null,
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
      isSameSelection(reader, entry.state)
    ) {
      // Rendered with or without this action, the reader shows the same.
      const shownState = readStoreState(store, reader.root, NoLanes);
      if (is(shownState, entry.state) || isSameSelection(reader, shownState)) {
        return;
      }
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
  return entry;
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
    storeInternals.delete(internals.store);
  }
}

function isStoreEntryShownEverywhere<S, A>(
  internals: StoreInternals<S, A>,
  entry: StoreEntry<S, A>,
): boolean {
  if (entry.transition !== null) {
    // A root may still render it before its Transition's scope finishes.
    return false;
  }
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
  const store = reader.store;
  const internals = getStoreInternals(store, store.getState());
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

// Called when a Transition's scope finishes, with the lane of the work it
// scheduled, if any.
export function finishStoreTransition(transition: Transition, lane: Lane): void {
  const stores = transitionStores.get(transition);
  if (stores === undefined) {
    return;
  }
  transitionStores.delete(transition);
  const action = peekEntangledActionThenable();
  const actionLane = peekEntangledActionLane();
  stores.forEach(internals => {
    const entries = internals.entries;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.transition === transition) {
        entry.transition = null;
        internals.transitions--;
        internals.version++;
        if (
          action !== null &&
          entry.lane === actionLane &&
          internals.action !== action
        ) {
          internals.action = action;
          const onActionFinish = () =>
            finishStoreAction(internals, actionLane);
          action.then(onActionFinish, onActionFinish);
        }
      }
      if (lane === NoLane || entry.lane !== lane) {
        continue;
      }
      // Updates in a lane render together, so a root the Transition scheduled
      // work on also waits to show the actions dispatched in its lane.
      internals.version++;
      let root = firstScheduledRoot;
      while (root !== null) {
        if (
          includesSomeLane(root.pendingLanes, lane) &&
          !entry.committedRoots.has(root)
        ) {
          if (!internals.roots.has(root)) {
            addStoreRoot(internals, root, 0);
          }
          entry.pendingRoots.add(root);
        }
        root = root.next;
      }
    }
    compactStoreEntries(internals);
  });
}

// Called when an async Action the store has actions in finishes. A root that
// had no work pending for them shows them now.
function finishStoreAction<S, A>(
  internals: StoreInternals<S, A>,
  lane: Lane,
): void {
  internals.action = null;
  internals.version++;
  // Readers show the Action's updates in its lane, together, and without
  // showing a fallback.
  internals.readers.forEach(reader => {
    if (didStoreReaderMissAction(reader)) {
      const fiber = reader.fiber;
      const readerLane =
        (fiber.mode & ConcurrentMode) === NoMode ? SyncLane : lane;
      const root = enqueueConcurrentRenderForLane(fiber, readerLane);
      if (root !== null) {
        scheduleUpdateOnFiber(root, fiber, readerLane);
      }
    }
  });
  compactStoreEntries(internals);
}

// What each selection committed in each root, which is the previous value its
// select function is given.
const committedSelections: WeakMap<
  ReactStore<any, any>,
  WeakMap<FiberRoot, {value: any}>,
> = new WeakMap();

// The store a selection is selected from.
export function getStoreSource<S>(
  store: ReactStore<S, mixed>,
): ReactStore<any, any> {
  let source: ReactStore<any, any> = store;
  while (source._parent != null) {
    source = source._parent;
  }
  return source;
}

function getCommittedSelection<S>(
  selection: ReactStore<S, mixed>,
  root: FiberRoot,
): S | void {
  const roots = committedSelections.get(selection);
  if (roots === undefined) {
    return undefined;
  }
  const committed = roots.get(root);
  return committed === undefined ? undefined : committed.value;
}

function commitSelection<S>(
  selection: ReactStore<S, mixed>,
  root: FiberRoot,
  value: S,
): void {
  let roots = committedSelections.get(selection);
  if (roots === undefined) {
    roots = new WeakMap();
    committedSelections.set(selection, roots);
  }
  const committed = roots.get(root);
  if (committed === undefined) {
    roots.set(root, {value});
  } else {
    committed.value = value;
  }
}

// A selection's value for a root, from the state of the store it was selected
// from. Each select function is given what it returned for this root before.
export function readStoreSelection<S, T>(
  selection: ReactStore<T, mixed>,
  sourceState: S,
  root: FiberRoot,
  previous: T | void,
): T {
  const parent = selection._parent;
  if (parent == null) {
    return sourceState as any;
  }
  const parentState = readStoreSelection(
    parent,
    sourceState,
    root,
    getCommittedSelection(parent, root),
  );
  const select: (state: any, previous: T | void) => T = selection._select as any;
  return select(parentState, previous);
}

// A store read with use() is recorded on the fiber, like a context, so it can
// be read in a condition or a loop. The commit subscribes it.
export function pushStoreDependency<S, T>(
  fiber: Fiber,
  root: FiberRoot,
  store: ReactStore<T, mixed>,
  state: S,
  value: T,
): void {
  const dependency: StoreDependency = {
    store,
    root,
    state,
    value,
    reader: null,
    unsubscribe: null,
    next: null,
  };
  const dependencies = fiber.dependencies;
  if (dependencies === null) {
    fiber.dependencies = {
      lanes: NoLanes,
      firstContext: null,
      firstStore: dependency,
    };
  } else {
    const first = dependencies.firstStore;
    if (first == null) {
      dependencies.firstStore = dependency;
    } else {
      let last: StoreDependency = first;
      while (last.next !== null) {
        last = last.next;
      }
      last.next = dependency;
    }
  }
  // So the commit visits this fiber and subscribes the read.
  fiber.flags |= Update;
}

// What the fiber's last committed render read here. A read that selects the
// same store again is given what it rendered, even when the selection is new,
// so a selection built during render can still share structure with it.
export function getCommittedStoreDependencyValue<T>(
  fiber: Fiber,
  store: ReactStore<T, mixed>,
): T | typeof noEagerSelection {
  const current = fiber.alternate;
  if (current === null || current.dependencies == null) {
    return noEagerSelection;
  }
  const first: StoreDependency | null = current.dependencies.firstStore ?? null;
  if (first === null) {
    return noEagerSelection;
  }
  // The position this read takes in the list.
  let index = 0;
  let read: StoreDependency | null =
    fiber.dependencies == null ? null : (fiber.dependencies.firstStore ?? null);
  while (read !== null) {
    index++;
    read = read.next;
  }
  const source = getStoreSource(store);
  let atIndex: StoreDependency | null = null;
  let position = 0;
  let dependency: StoreDependency | null = first;
  while (dependency !== null) {
    if (dependency.store === store) {
      return dependency.value;
    }
    if (position === index) {
      atIndex = dependency;
    }
    position++;
    dependency = dependency.next;
  }
  if (atIndex !== null && getStoreSource(atIndex.store) === source) {
    // The same read, of the same store, through a selection it replaced.
    return atIndex.value;
  }
  return noEagerSelection;
}

// What the selection returned when an action was dispatched, if this render
// reads the same state. Selecting again would return the same thing.
export function getEagerStoreDependencySelection<S, T>(
  fiber: Fiber,
  selection: ReactStore<T, mixed>,
  sourceState: S,
  previous: T | void,
): T | typeof noEagerSelection {
  const current = fiber.alternate;
  if (current === null || current.dependencies == null) {
    return noEagerSelection;
  }
  let dependency: StoreDependency | null =
    current.dependencies.firstStore ?? null;
  while (dependency !== null) {
    if (dependency.store === selection) {
      const reader = dependency.reader;
      return reader === null
        ? noEagerSelection
        : getEagerStoreSelection(reader, sourceState, reader.selector, previous);
    }
    dependency = dependency.next;
  }
  return noEagerSelection;
}

function takeStoreDependency(
  first: StoreDependency | null,
  store: ReactStore<any, any>,
): StoreDependency | null {
  let dependency = first;
  while (dependency !== null) {
    if (dependency.store === store && dependency.reader !== null) {
      return dependency;
    }
    dependency = dependency.next;
  }
  return null;
}

// Called when a fiber that read stores with use() commits. A read the fiber
// kept keeps its subscription; one it dropped is released.
export function commitStoreDependencies(
  current: Fiber | null,
  finishedWork: Fiber,
): void {
  const dependencies = finishedWork.dependencies;
  const previous: StoreDependency | null =
    current === null || current.dependencies == null
      ? null
      : (current.dependencies.firstStore ?? null);
  let dependency: StoreDependency | null =
    dependencies == null ? null : (dependencies.firstStore ?? null);
  if (dependency === null && previous === null) {
    return;
  }
  while (dependency !== null) {
    const kept = takeStoreDependency(previous, dependency.store);
    if (kept !== null) {
      const reader: StoreReader<any, any> = kept.reader as any;
      reader.fiber = finishedWork;
      reader.state = dependency.state;
      reader.value = dependency.value;
      dependency.reader = reader;
      dependency.unsubscribe = kept.unsubscribe;
      kept.reader = null;
      kept.unsubscribe = null;
    } else {
      subscribeStoreDependency(finishedWork, dependency);
    }
    commitSelection(dependency.store, dependency.root, dependency.value);
    dependency = dependency.next;
  }
  let dropped: StoreDependency | null = previous;
  while (dropped !== null) {
    releaseStoreDependency(dropped);
    dropped = dropped.next;
  }
}

function releaseStoreDependency(dependency: StoreDependency): void {
  const unsubscribe = dependency.unsubscribe;
  if (unsubscribe !== null) {
    dependency.reader = null;
    dependency.unsubscribe = null;
    unsubscribe();
  }
}

function subscribeStoreDependency(
  fiber: Fiber,
  dependency: StoreDependency,
): void {
  const selection = dependency.store;
  const root = dependency.root;
  const reader: StoreReader<any, any> = {
    store: getStoreSource(selection),
    root,
    fiber,
    selector: (state: any, previous: any) =>
      readStoreSelection(selection, state, root, previous),
    value: dependency.value,
    state: dependency.state,
    eagerState: noEagerSelection,
    eagerValue: noEagerSelection,
  };
  dependency.reader = reader;
  dependency.unsubscribe = subscribeToStoreReader(reader);
  if (didStoreReaderMissAction(reader)) {
    // Dispatched between the render and now.
    const scheduledRoot = enqueueConcurrentRenderForLane(fiber, SyncLane);
    if (scheduledRoot !== null) {
      scheduleUpdateOnFiber(scheduledRoot, fiber, SyncLane);
    }
  }
}

// Called when a fiber that read stores with use() is deleted or hidden.
export function releaseStoreDependencies(fiber: Fiber): void {
  const dependencies = fiber.dependencies;
  let dependency: StoreDependency | null =
    dependencies == null ? null : (dependencies.firstStore ?? null);
  while (dependency !== null) {
    releaseStoreDependency(dependency);
    dependency = dependency.next;
  }
}

// Called when a hidden fiber that read stores with use() is revealed.
export function remountStoreDependencies(fiber: Fiber): void {
  const dependencies = fiber.dependencies;
  let dependency: StoreDependency | null =
    dependencies == null ? null : (dependencies.firstStore ?? null);
  while (dependency !== null) {
    if (dependency.reader === null) {
      subscribeStoreDependency(fiber, dependency);
    }
    dependency = dependency.next;
  }
}

// Whether a reader shows something other than what its root shows now,
// because it was not subscribed when an action was dispatched.
export function didStoreReaderMissAction<S, T>(
  reader: StoreReader<S, T>,
): boolean {
  const state = readStoreState(reader.store, reader.root, NoLanes);
  if (is(state, reader.state)) {
    return false;
  }
  return !isSameSelection(reader, state);
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
