/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {ReactStore, StoreVersion} from 'shared/ReactTypes';

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
  const reduce = (state: S, action: A): S => {
    if (__DEV__ && (store._strictReaders || 0) > 0) {
      // Like StrictMode does for useReducer, surface an impure reducer by
      // calling it twice.
      actualReducer(state, action);
    }
    return actualReducer(state, action);
  };
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

      const headState = reduce(head.state, action);
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
          const syncState = reduce(sync.state, action);
          if (!is(syncState, sync.state)) {
            nextSync = {state: syncState};
          }
        }
      }
      if (nextHead === head && nextSync === sync) {
        return;
      }

      store._head = nextHead;
      store._sync = nextSync;
      // The renderer marks the roots this Transition scheduled work on when
      // its scope finishes.
      let isMarkedByRenderer = false;
      if (transition !== null && ReactSharedInternals.S !== null) {
        isMarkedByRenderer = true;
        if (transition.stores === null) {
          transition.stores = new Set();
        }
        transition.stores.add(store);
      }
      const readers = Array.from(store._readers);
      for (let i = 0; i < readers.length; i++) {
        readers[i](isTransition);
      }
      // Nothing waits on this dispatch, so the state on screen is the latest.
      if (!isMarkedByRenderer && store._rootsBehind === 0) {
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
    _initial: initial,
    _head: initial,
    _sync: initial,
    _readers: new Set(),
    _roots: new Map(),
    _rootsBehind: 0,
  };
  if (__DEV__) {
    store._strictReaders = 0;
  }
  return store;
}
