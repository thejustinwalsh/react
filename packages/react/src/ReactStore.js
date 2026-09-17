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
      // Renderers are told first, so one that is rendering can reject the
      // action before the state changes. They are told of an action that
      // changes nothing too, which can still apply to what a root shows.
      store._listeners.forEach(listener => listener(action, nextState));
      state = nextState;
      if (transition !== null && store._listeners.size === 0) {
        // A renderer that renders this Transition picks it up when the
        // Transition's scope finishes.
        if (transition.storeActions == null) {
          transition.storeActions = [];
        }
        transition.storeActions.push({
          store,
          action,
          previousState,
          state: nextState,
        });
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
    _initialState: initialState,
    _reducer: reducer === undefined ? (basicStateReducer as any) : reducer,
    _listeners: new Set(),
  };
  return store;
}
