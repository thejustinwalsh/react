/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {ReactStore} from 'shared/ReactTypes';

import ReactSharedInternals from 'shared/ReactSharedInternals';
import {REACT_STORE_TYPE} from 'shared/ReactSymbols';
import is from 'shared/objectIs';
import {enableGestureTransition} from 'shared/ReactFeatureFlags';

function basicStateReducer<S>(state: S, action: S | (S => S)): S {
  // $FlowFixMe[incompatible-use]: Flow doesn't like mixed types
  return typeof action === 'function' ? action(state) : action;
}

// A selection of a store's state. It is read like a store, and refined like
// one, but only the store it came from is dispatched to.
function createSelection<S, T>(
  parent: ReactStore<S, any>,
  select: (state: S, previous: T | void) => T,
): ReactStore<T, empty> {
  const selection: ReactStore<T, empty> = {
    $$typeof: REACT_STORE_TYPE,
    getState(): T {
      return select(parent.getState(), undefined);
    },
    dispatch(action: empty): void {
      throw new Error(
        'Cannot dispatch to a selection of a store. Dispatch to the store it ' +
          'was selected from.',
      );
    },
    subscribe(callback: () => void): () => void {
      let previous = selection.getState();
      return parent.subscribe(() => {
        const next = select(parent.getState(), previous);
        if (!is(next, previous)) {
          previous = next;
          callback();
        }
      });
    },
    select<U>(next: (state: T, previous: U | void) => U): ReactStore<U, empty> {
      return createSelection(selection, next);
    },
    _initialState: select(parent._initialState, undefined),
    _reducer: (state: T, action: empty) => state,
    _parent: parent,
    _select: select,
  };
  return selection;
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
  let state = initialState;
  const subscriptions: Set<() => void> = new Set();
  const store: ReactStore<S, A> = {
    $$typeof: REACT_STORE_TYPE,
    getState(): S {
      return state;
    },
    dispatch(action: A): void {
      // A server has no Transitions.
      const transition = ReactSharedInternals.T ?? null;
      if (enableGestureTransition) {
        if (transition !== null && transition.gesture) {
          throw new Error(
            'Cannot dispatch to a store inside a startGestureTransition. ' +
              'Gestures can only update the useOptimistic() hook.',
          );
        }
      }
      const previousState = state;
      const nextState = store._reducer(previousState, action);
      // Renderers get the update before the state changes, so one that is
      // rendering can reject it. They get an update that changes nothing too,
      // which can still apply to what a root shows. A server has no renderers.
      const onStoreUpdate = ReactSharedInternals.U;
      if (onStoreUpdate != null) {
        onStoreUpdate({store, action, previousState, state: nextState});
      }
      state = nextState;
      if (transition !== null) {
        transition.didUpdateStore = true;
      }
      if (!is(nextState, previousState)) {
        subscriptions.forEach(callback => callback());
      }
    },
    subscribe(callback: () => void): () => void {
      subscriptions.add(callback);
      return () => {
        subscriptions.delete(callback);
      };
    },
    select<T>(select: (state: S, previous: T | void) => T): ReactStore<T, empty> {
      return createSelection(store, select);
    },
    _initialState: initialState,
    _reducer: reducer === undefined ? (basicStateReducer as any) : reducer,
  };
  return store;
}
