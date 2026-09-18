/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 */

'use strict';

let React;
let ReactNoop;
let Scheduler;
let act;
let assertLog;
let createStore;
let useStore;
let useState;
let startTransition;
let use;
let Suspense;
let promises;

describe('useStore', () => {
  beforeEach(() => {
    jest.resetModules();
    global.reportError = error => {
      Scheduler.log('reportError: ' + error.message);
    };

    React = require('react');
    ReactNoop = require('react-noop-renderer');
    Scheduler = require('scheduler');
    createStore = React.createStore;
    useStore = React.useStore;
    useState = React.useState;
    startTransition = React.startTransition;
    use = React.use;
    Suspense = React.Suspense;
    promises = new Map();

    const InternalTestUtils = require('internal-test-utils');
    act = InternalTestUtils.act;
    assertLog = InternalTestUtils.assertLog;
  });

  function Text({text}) {
    Scheduler.log(text);
    return text;
  }

  function getPromise(text) {
    let resolve;
    const promise = new Promise(r => (resolve = r));
    promises.set(text, () => resolve(text));
    return promise;
  }
  function resolvePromise(text) {
    const resolve = promises.get(text);
    if (resolve !== undefined) {
      resolve();
    }
  }

  // @gate enableStore
  it('reads the state of the store', async () => {
    const store = createStore(1);
    function App() {
      return <Text text={String(useStore(store))} />;
    }

    const root = ReactNoop.createRoot();
    await act(() => root.render(<App />));
    assertLog(['1']);
    expect(root).toMatchRenderedOutput('1');
  });

  // @gate enableStore
  it('dispatches a value or an updater without a reducer', async () => {
    const store = createStore(1);
    function App() {
      return <Text text={String(useStore(store))} />;
    }

    const root = ReactNoop.createRoot();
    await act(() => root.render(<App />));
    assertLog(['1']);

    await act(() => store.dispatch(5));
    assertLog(['5']);
    await act(() => store.dispatch(n => n + 1));
    assertLog(['6']);
    expect(store.getState()).toBe(6);
    expect(root).toMatchRenderedOutput('6');
  });

  // @gate enableStore
  it('dispatches actions to a reducer', async () => {
    const store = createStore(0, (n, action) =>
      action.type === 'add' ? n + action.by : n,
    );
    function App() {
      return <Text text={String(useStore(store))} />;
    }

    const root = ReactNoop.createRoot();
    await act(() => root.render(<App />));
    assertLog(['0']);

    await act(() => store.dispatch({type: 'add', by: 2}));
    assertLog(['2']);
    expect(root).toMatchRenderedOutput('2');
  });

  // @gate enableStore
  it('does not render when the selected state did not change', async () => {
    const store = createStore({a: 0, b: 0});
    function A() {
      return <Text text={'a' + useStore(store, s => s.a)} />;
    }
    function B() {
      return <Text text={'b' + useStore(store, s => s.b)} />;
    }

    const root = ReactNoop.createRoot();
    await act(() =>
      root.render(
        <>
          <A />
          <B />
        </>,
      ),
    );
    assertLog(['a0', 'b0']);

    await act(() => store.dispatch(s => ({...s, a: 1})));
    assertLog(['a1']);
  });

  // @gate enableStore
  it('passes the previous selection to the selector', async () => {
    const store = createStore({items: [1, 2], other: 0});
    const selections = [];
    function App() {
      const items = useStore(store, (state, previous) =>
        previous !== undefined &&
        previous.length === state.items.length &&
        previous.every((item, i) => item === state.items[i])
          ? previous
          : state.items.slice(),
      );
      selections.push(items);
      return <Text text={items.join(',')} />;
    }

    const root = ReactNoop.createRoot();
    await act(() => root.render(<App />));
    assertLog(['1,2']);

    // A new array with the same items keeps the previous selection, so
    // nothing renders.
    await act(() => store.dispatch(s => ({...s, items: [1, 2]})));
    assertLog([]);
    expect(selections.length).toBe(1);
  });

  // @gate enableStore
  it('starts a fresh selection when the store changes', async () => {
    const first = createStore(1);
    const second = createStore(2);
    const previousValues = [];
    let setStore;
    function App() {
      const [store, _setStore] = useState(first);
      setStore = _setStore;
      const value = useStore(store, (state, previous) => {
        previousValues.push(previous);
        return state;
      });
      return <Text text={String(value)} />;
    }

    const root = ReactNoop.createRoot();
    await act(() => root.render(<App />));
    assertLog(['1']);
    previousValues.length = 0;

    await act(() => setStore(second));
    assertLog(['2']);
    expect(previousValues[0]).toBe(undefined);

    // Actions to the previous store no longer render.
    await act(() => first.dispatch(3));
    assertLog([]);
    await act(() => second.dispatch(4));
    assertLog(['4']);
  });

  // @gate enableStore
  it('judges a dispatch from a layout effect with the selector that rendered', async () => {
    const store = createStore({a: 0, b: 0});
    let setKey;
    function Dispatcher({isArmed}) {
      React.useLayoutEffect(() => {
        if (isArmed) {
          store.dispatch(s => ({...s, b: 1}));
        }
      }, [isArmed]);
      return null;
    }
    function Reader({field}) {
      const value = useStore(store, s => s[field]);
      return <Text text={field + '=' + value} />;
    }
    function App() {
      const [key, _setKey] = useState('a');
      setKey = _setKey;
      return (
        <>
          <Dispatcher isArmed={key === 'b'} />
          <Reader field={key} />
        </>
      );
    }

    const root = ReactNoop.createRoot();
    await act(() => root.render(<App />));
    assertLog(['a=0']);

    await act(() => setKey('b'));
    assertLog(['b=0', 'b=1']);
    expect(root).toMatchRenderedOutput('b=1');
  });

  // @gate enableStore
  it('does not render a reader that switched stores for a change it does not select', async () => {
    const first = createStore({a: 0, b: 0});
    const second = createStore({a: 0, b: 0});
    function Reader({store}) {
      return <Text text={'a=' + useStore(store, s => s.a)} />;
    }
    const root = ReactNoop.createRoot();
    await act(() => root.render(<Reader store={first} />));
    assertLog(['a=0']);
    await act(() => root.render(<Reader store={second} />));
    assertLog(['a=0']);

    await act(() => second.dispatch(s => ({...s, b: 1})));
    assertLog([]);
    await act(() => second.dispatch(s => ({...s, a: 1})));
    assertLog(['a=1']);
  });

  // @gate enableStore
  it('does not commit a reader for a change it does not select', async () => {
    const store = createStore({unread: 0, theme: 'dark'});
    let commits = 0;
    function Unread() {
      const unread = useStore(store, s => s.unread);
      React.useEffect(() => {
        commits++;
      });
      return <Text text={'unread:' + unread} />;
    }
    const root = ReactNoop.createRoot();
    await act(() => root.render(<Unread />));
    assertLog(['unread:0']);
    await act(() => store.dispatch(s => ({...s, unread: 1})));
    assertLog(['unread:1']);
    expect(commits).toBe(2);

    // The reader may render to find out, but it does not commit.
    await act(() => store.dispatch(s => ({...s, theme: 'light'})));
    assertLog([]);
    expect(commits).toBe(2);
    await act(() => store.dispatch(s => ({...s, theme: 'dark'})));
    assertLog([]);
    expect(commits).toBe(2);
  });

  // @gate enableStore
  it('throws selector errors during render', async () => {
    const store = createStore(0);
    class ErrorBoundary extends React.Component {
      state = {error: null};
      static getDerivedStateFromError(error) {
        return {error};
      }
      render() {
        return this.state.error !== null ? (
          <Text text={this.state.error.message} />
        ) : (
          this.props.children
        );
      }
    }
    function App() {
      const value = useStore(store, n => {
        if (n > 0) {
          throw new Error('Oops');
        }
        return n;
      });
      return <Text text={String(value)} />;
    }

    const root = ReactNoop.createRoot();
    await act(() =>
      root.render(
        <ErrorBoundary>
          <App />
        </ErrorBoundary>,
      ),
    );
    assertLog(['0']);

    // The throw inside dispatch is caught and happens again in render.
    await act(() => store.dispatch(1));
    assertLog(['Oops', 'Oops']);
    expect(root).toMatchRenderedOutput('Oops');
  });

  // @gate enableStore
  it('notifies subscribers when the state changes', () => {
    const store = createStore(0, (n, action) => n + action.by);
    const states = [];
    const unsubscribe = store.subscribe(() => states.push(store.getState()));
    store.dispatch({by: 2});
    store.dispatch({by: 0});
    unsubscribe();
    store.dispatch({by: 3});
    expect(states).toEqual([2]);
    expect(store.getState()).toBe(5);
  });

  // @gate enableStore
  it('does not pass the previous store’s selection after the store changes', async () => {
    const first = createStore(1);
    const second = createStore(undefined);
    let setStore;
    function App() {
      const [store, _setStore] = useState(first);
      setStore = _setStore;
      const value = useStore(store, (state, previous) =>
        previous === 1 ? previous : state,
      );
      return <Text text={String(value)} />;
    }

    const root = ReactNoop.createRoot();
    await act(() => root.render(<App />));
    assertLog(['1']);

    await act(() => setStore(second));
    assertLog(['undefined']);
    await act(() => second.dispatch(2));
    assertLog(['2']);
    expect(root).toMatchRenderedOutput('2');
  });

  // @gate enableStore
  it('keeps its state consistent when a subscriber throws', async () => {
    const store = createStore(0);
    store.subscribe(() => {
      throw new Error('Oops');
    });
    let error;
    startTransition(() => {
      try {
        store.dispatch(1);
      } catch (x) {
        error = x;
      }
    });
    expect(error.message).toBe('Oops');

    function App() {
      return <Text text={String(useStore(store))} />;
    }
    const root = ReactNoop.createRoot();
    await act(() => root.render(<App />));
    assertLog(['1']);
  });

  // @gate enableStore
  it('calls the reducer twice in development when a reader is in StrictMode', async () => {
    let calls = 0;
    const reducer = (n, by) => {
      calls++;
      return n + by;
    };
    function Reader({store}) {
      return <Text text={String(useStore(store))} />;
    }

    const strictStore = createStore(0, reducer);
    const strictRoot = ReactNoop.createRoot();
    await act(() =>
      strictRoot.render(
        <React.StrictMode>
          <Reader store={strictStore} />
        </React.StrictMode>,
      ),
    );
    assertLog(['0']);
    await act(() => strictStore.dispatch(1));
    assertLog(['1']);
    expect(calls).toBe(__DEV__ ? 2 : 1);
    expect(strictStore.getState()).toBe(1);

    calls = 0;
    const store = createStore(0, reducer);
    const root = ReactNoop.createRoot();
    await act(() => root.render(<Reader store={store} />));
    assertLog(['0']);
    await act(() => store.dispatch(1));
    assertLog(['1']);
    expect(calls).toBe(1);

    // Once the StrictMode reader unmounts, the store no longer double-invokes.
    await act(() => strictRoot.render(null));
    calls = 0;
    await act(() => strictStore.dispatch(1));
    expect(calls).toBe(1);
  });

  // @gate enableStore && enableGestureTransition
  it('throws when dispatching inside a gesture Transition', async () => {
    const store = createStore(0);
    function App() {
      return <Text text={String(useStore(store))} />;
    }
    const root = ReactNoop.createRoot();
    await act(() => root.render(<App />));
    assertLog(['0']);

    let error;
    React.unstable_startGestureTransition({}, () => {
      try {
        store.dispatch(1);
      } catch (x) {
        error = x;
      }
    });
    expect(error.message).toContain(
      'Cannot dispatch to a store inside a startGestureTransition.',
    );
    // Nothing changed, so nothing renders.
    expect(store.getState()).toBe(0);
    await act(() => {});
    assertLog([]);
    expect(root).toMatchRenderedOutput('0');
  });

  // @gate enableStore
  it('reuses the selection it made when the action was dispatched', async () => {
    const store = createStore({count: 0}, state => ({count: state.count + 1}));
    const selector = jest.fn(state => state.count);
    function App() {
      return <Text text={'n' + useStore(store, selector)} />;
    }
    const root = ReactNoop.createRoot();
    await act(() => root.render(<App />));
    assertLog(['n0']);
    expect(selector).toHaveBeenCalledTimes(1);

    await act(() => store.dispatch());
    assertLog(['n1']);
    expect(selector).toHaveBeenCalledTimes(2);
  });

  // @gate enableStore
  it('throws when a store with no readers is dispatched to while rendering', async () => {
    const store = createStore(0);
    class ErrorBoundary extends React.Component {
      state = {error: null};
      static getDerivedStateFromError(error) {
        return {error};
      }
      render() {
        if (this.state.error !== null) {
          return <Text text={this.state.error.message} />;
        }
        return this.props.children;
      }
    }
    function App() {
      store.dispatch(1);
      return <Text text="App" />;
    }

    const root = ReactNoop.createRoot();
    await act(() =>
      root.render(
        <ErrorBoundary>
          <App />
        </ErrorBoundary>,
      ),
    );
    assertLog([
      'Cannot dispatch to a store while rendering. Dispatch from an event ' +
        'handler or an effect instead.',
      'Cannot dispatch to a store while rendering. Dispatch from an event ' +
        'handler or an effect instead.',
    ]);
    expect(store.getState()).toBe(0);
  });

  // @gate enableStore
  it('reads a store with use()', async () => {
    const store = createStore(0, (n, by) => n + by);
    function App({show}) {
      return <Text text={'n' + (show ? use(store) : '-')} />;
    }
    const root = ReactNoop.createRoot();
    await act(() => root.render(<App show={true} />));
    assertLog(['n0']);

    await act(() => store.dispatch(1));
    assertLog(['n1']);
    expect(root).toMatchRenderedOutput('n1');

    await act(() => startTransition(() => store.dispatch(10)));
    assertLog(['n11']);
    expect(root).toMatchRenderedOutput('n11');
  });

  // @gate enableStore
  it('suspends on a store whose state is a promise, and resolves it with use()', async () => {
    const store = createStore(getPromise('first'));
    function App() {
      return <Text text={use(store)} />;
    }
    const root = ReactNoop.createRoot();
    await act(() =>
      root.render(
        <Suspense fallback={<Text text="Loading" />}>
          <App />
        </Suspense>,
      ),
    );
    assertLog(['Loading']);
    expect(root).toMatchRenderedOutput('Loading');

    await act(() => resolvePromise('first'));
    assertLog(['first']);
    expect(root).toMatchRenderedOutput('first');

    // A new promise in the store suspends again, in a Transition without a
    // fallback.
    await act(() =>
      startTransition(() => store.dispatch(getPromise('second'))),
    );
    assertLog(['Loading']);
    // A Transition keeps the resolved value on screen while the new promise
    // is pending.
    expect(root).toMatchRenderedOutput('first');

    await act(() => resolvePromise('second'));
    assertLog(['second']);
    expect(root).toMatchRenderedOutput('second');
  });
});
