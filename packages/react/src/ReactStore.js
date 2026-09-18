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

// A value selected from one or more stores. It is read like a store, and
// refined like one, but only the stores it came from are dispatched to.
export function createStoreSelector<T>(
  sources: Array<ReactStore<any, any>>,
  select: (states: Array<any>, previous: T | void) => T,
): ReactStore<T, empty> {
  const selection: ReactStore<T, empty> = {
    $$typeof: REACT_STORE_TYPE,
    getState(): T {
      return select(
        sources.map(source => source.getState()),
        undefined,
      );
    },
    dispatch(action: empty): void {
      throw new Error(
        'Cannot dispatch to a selection of a store. Dispatch to the store it ' +
          'was selected from.',
      );
    },
    subscribe(callback: () => void): () => void {
      let previous = selection.getState();
      const unsubscribes = sources.map(source =>
        source.subscribe(() => {
          const next = select(
            sources.map(each => each.getState()),
            previous,
          );
          if (!is(next, previous)) {
            previous = next;
            callback();
          }
        }),
      );
      return () => unsubscribes.forEach(unsubscribe => unsubscribe());
    },
    select<U>(next: (state: T, previous: U | void) => U): ReactStore<U, empty> {
      return createStoreSelector([selection], ([state], previous) =>
        next(state, previous),
      );
    },
    // A selection hydrates from the state its sources were created with, so it
    // does not keep one of its own.
    get _initialState(): T {
      return select(
        sources.map(source => source._initialState),
        undefined,
      );
    },
    _reducer: (state: T, action: empty) => state,
    _sources: sources,
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
      return createStoreSelector([store], ([selected], previous) =>
        select(selected, previous),
      );
    },
    _initialState: initialState,
    _reducer: reducer === undefined ? (basicStateReducer as any) : reducer,
  };
  return store;
}
