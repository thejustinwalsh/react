/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {ReactStore, StoreUpdate, StoreVersion} from 'shared/ReactTypes';
import type {Transition} from './ReactStartTransition';

import ReactSharedInternals from 'shared/ReactSharedInternals';
import {REACT_STORE_TYPE} from 'shared/ReactSymbols';
import is from 'shared/objectIs';
import {enableGestureTransition} from 'shared/ReactFeatureFlags';

function basicStateReducer<S>(state: S, action: S | (S => S)): S {
  // $FlowFixMe[incompatible-use]: Flow doesn't like mixed types
  return typeof action === 'function' ? action(state) : action;
}

declare export function createStore<S>(
  initialState: S,
): ReactStore<S, S | ((previous: S) => S)>;
declare export function createStore<S, A>(
  initialState: S,
  reducer: (S, A) => S,
): ReactStore<S, A>;
export function createStore<S, A>(
  initialState: S,
  reducer?: (S, A) => S,
): ReactStore<S, A> {
  const actualReducer: (S, A) => S =
    reducer === undefined ? (basicStateReducer as any) : reducer;
  const initial: StoreVersion<S> = {state: initialState};
  const subscriptions: Set<(action: A) => void> = new Set();
  const store: ReactStore<S, A> = {
    $$typeof: REACT_STORE_TYPE,
    getState(): S {
      return store._head.state;
    },
    dispatch(action: A): void {
      const transition = ReactSharedInternals.T;
      if (
        enableGestureTransition &&
        transition !== null &&
        transition.gesture
      ) {
        throw new Error(
          'Cannot setState on regular state inside a startGestureTransition. ' +
            'Gestures can only update the useOptimistic() hook. There should be no ' +
            'side-effects associated with starting a Gesture until its Action is ' +
            'invoked. Move side-effects to the Action instead.',
        );
      }
      const head = store._head;
      const sync = store._sync;
      const isTransition = transition !== null;

      const headState = actualReducer(head.state, action);
      const nextHead: StoreVersion<S> = is(headState, head.state)
        ? head
        : {state: headState};

      // A Transition leaves the state a root shows alone. A blocking action
      // applies to it immediately, the way React rebases updates to useState.
      let nextSync = sync;
      if (!isTransition) {
        if (sync === head) {
          nextSync = nextHead;
        } else {
          const syncState = actualReducer(sync.state, action);
          if (!is(syncState, sync.state)) {
            nextSync = {state: syncState};
          }
        }
      }
      // The renderer marks the roots this Transition scheduled work on when
      // its scope finishes.
      const isMarkedByRenderer =
        transition !== null && ReactSharedInternals.S !== null;
      const didChange = nextHead !== head || nextSync !== sync;
      store._head = nextHead;
      store._sync = nextSync;
      // Like an update to a hook queue, a Transition on a store that already
      // has one pending entangles with it even if it changes nothing.
      if (
        transition !== null &&
        isMarkedByRenderer &&
        (didChange || store._rootsBehind > 0 || store._isTransitionQueued)
      ) {
        queueTransitionStore(transition, store);
      }
      // Every action reaches every reader, as every setState reaches its hook.
      const update: StoreUpdate<S, A> = {
        action,
        version: null,
        head,
        nextHead,
        sync: isTransition ? null : sync,
        nextSync,
      };
      const readers = Array.from(store._readers);
      for (let i = 0; i < readers.length; i++) {
        readers[i](update);
      }
      if (!didChange) {
        return;
      }
      // Nothing waits on this dispatch, so the state on screen is the latest.
      if (
        !isMarkedByRenderer &&
        !store._isTransitionQueued &&
        store._pendingAction === null &&
        store._rootsBehind === 0
      ) {
        store._sync = store._head;
        store._roots.clear();
      }
      subscriptions.forEach(callback => callback(action));
    },
    subscribe(callback: (action: A) => void): () => void {
      subscriptions.add(callback);
      return () => {
        subscriptions.delete(callback);
      };
    },
    _reducer: actualReducer,
    _initial: initial,
    _head: initial,
    _sync: initial,
    _readers: new Set(),
    _roots: new Map(),
    _rootsBehind: 0,
    _isTransitionQueued: false,
    _pendingAction: null,
  };
  return store;
}

function queueTransitionStore<S, A>(
  transition: Transition,
  store: ReactStore<S, A>,
): void {
  store._isTransitionQueued = true;
  if (transition.stores === null) {
    transition.stores = new Set();
  }
  transition.stores.add(store);
}
