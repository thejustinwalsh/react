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
let waitForAll;
let createStore;
let useStore;
let useState;
let startTransition;
let Suspense;
let Activity;
let flushSync;
let textCache;
let microtaskCount;

const originalQueueMicrotask = global.queueMicrotask;

describe('useStore', () => {
  afterEach(() => {
    global.queueMicrotask = originalQueueMicrotask;
  });

  beforeEach(() => {
    jest.resetModules();
    microtaskCount = 0;
    global.queueMicrotask = callback => {
      microtaskCount++;
      originalQueueMicrotask(callback);
    };
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
    Suspense = React.Suspense;
    Activity = React.Activity;
    flushSync = ReactNoop.flushSync;
    textCache = new Map();

    const InternalTestUtils = require('internal-test-utils');
    waitForAll = InternalTestUtils.waitForAll;
    act = InternalTestUtils.act;
    assertLog = InternalTestUtils.assertLog;
  });

  function resolveText(text) {
    const record = textCache.get(text);
    if (record === undefined) {
      textCache.set(text, {status: 'resolved', value: text});
    } else if (record.status === 'pending') {
      const thenable = record.value;
      record.status = 'resolved';
      record.value = text;
      thenable.pings.forEach(t => t());
    }
  }

  function readText(text) {
    const record = textCache.get(text);
    if (record !== undefined) {
      if (record.status === 'pending') {
        throw record.value;
      }
      return record.value;
    }
    const thenable = {
      pings: [],
      then(resolve) {
        if (newRecord.status === 'pending') {
          thenable.pings.push(resolve);
        } else {
          Promise.resolve().then(() => resolve(newRecord.value));
        }
      },
    };
    const newRecord = {status: 'pending', value: thenable};
    textCache.set(text, newRecord);
    throw thenable;
  }

  function Text({text}) {
    Scheduler.log(text);
    return text;
  }

  function AsyncText({text}) {
    readText(text);
    Scheduler.log(text);
    return text;
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
  it('keeps the previous state on screen while a Transition suspends', async () => {
    const store = createStore('A');
    function App() {
      const text = useStore(store);
      return text === 'A' ? <Text text="A" /> : <AsyncText text={text} />;
    }

    const root = ReactNoop.createRoot();
    await act(() =>
      root.render(
        <Suspense fallback={<Text text="Loading" />}>
          <App />
        </Suspense>,
      ),
    );
    assertLog(['A']);

    await act(() => startTransition(() => store.dispatch('B')));
    // The fallback renders but does not commit.
    assertLog(['Loading']);
    expect(root).toMatchRenderedOutput('A');

    await act(() => resolveText('B'));
    assertLog(['B']);
    expect(root).toMatchRenderedOutput('B');
  });

  // @gate enableStore
  it('rebases a blocking update over a pending Transition', async () => {
    const store = createStore({page: 'home', count: 0});
    function Page() {
      const page = useStore(store, s => s.page);
      return page === 'home' ? <Text text="home" /> : <AsyncText text={page} />;
    }
    function Count() {
      return <Text text={'count:' + useStore(store, s => s.count)} />;
    }

    const root = ReactNoop.createRoot();
    await act(() =>
      root.render(
        <>
          <Suspense fallback={<Text text="Loading" />}>
            <Page />
          </Suspense>
          <Count />
        </>,
      ),
    );
    assertLog(['home', 'count:0']);

    await act(() =>
      startTransition(() => store.dispatch(s => ({...s, page: 'about'}))),
    );
    assertLog(['Loading']);
    expect(root).toMatchRenderedOutput('homecount:0');

    // Applied to the state on screen now, and after the Transition's update.
    // Page has a pending update, so like useState it renders to rebase it.
    await act(() => store.dispatch(s => ({...s, count: s.count + 1})));
    assertLog(['home', 'count:1', 'Loading']);
    expect(root).toMatchRenderedOutput('homecount:1');

    await act(() => resolveText('about'));
    assertLog(['about']);
    expect(root).toMatchRenderedOutput('aboutcount:1');
    expect(store.getState()).toEqual({page: 'about', count: 1});
  });

  // @gate enableStore
  it('mounts a reader at the state on screen while a Transition is pending', async () => {
    const store = createStore('A');
    let showSecond;
    function Reader({label}) {
      const text = useStore(store);
      return text === 'A' ? (
        <Text text={label + text} />
      ) : (
        <AsyncText text={label + text} />
      );
    }
    function App() {
      const [second, setSecond] = useState(false);
      showSecond = setSecond;
      return (
        <Suspense fallback={<Text text="Loading" />}>
          <Reader label="1:" />
          {second ? <Reader label="2:" /> : null}
        </Suspense>
      );
    }

    const root = ReactNoop.createRoot();
    await act(() => root.render(<App />));
    assertLog(['1:A']);

    await act(() => startTransition(() => store.dispatch('B')));
    assertLog(['Loading']);
    expect(root).toMatchRenderedOutput('1:A');

    // A blocking render mounts a second reader. It shows what the first
    // reader shows, not the pending Transition's state.
    await act(() => showSecond(true));
    assertLog(['1:A', '2:A', 'Loading']);
    expect(root).toMatchRenderedOutput('1:A2:A');

    await act(() => {
      resolveText('1:B');
      resolveText('2:B');
    });
    assertLog(['1:B', '2:B']);
    expect(root).toMatchRenderedOutput('1:B2:B');
  });

  // @gate enableStore
  it('keeps each root on its own state while one waits on a Transition', async () => {
    const store = createStore(0, (n, by) => n + by);
    function Fast() {
      return <Text text={String(useStore(store))} />;
    }
    function Stalls() {
      const n = useStore(store);
      if (n >= 10) {
        readText('data');
      }
      return <Text text={String(n)} />;
    }

    const rootA = ReactNoop.createRoot();
    const rootB = ReactNoop.createRoot();
    await act(() => {
      rootA.render(<Fast />);
      rootB.render(
        <Suspense fallback={<Text text="Loading" />}>
          <Stalls />
        </Suspense>,
      );
    });
    assertLog(['0', '0']);

    // Root A commits the Transition; root B waits on data for it.
    await act(() => startTransition(() => store.dispatch(10)));
    assertLog(['10', 'Loading']);
    expect(rootA).toMatchRenderedOutput('10');
    expect(rootB).toMatchRenderedOutput('0');

    // Each root applies a blocking update to what it shows.
    await act(() => store.dispatch(1));
    assertLog(['11', '1', 'Loading']);
    expect(rootA).toMatchRenderedOutput('11');
    expect(rootB).toMatchRenderedOutput('1');

    await act(() => resolveText('data'));

    assertLog(['11']);
    expect(rootA).toMatchRenderedOutput('11');
    expect(rootB).toMatchRenderedOutput('11');
  });

  // @gate enableStore
  it('reads the latest state when the selector changes after a skipped update', async () => {
    const store = createStore({a: 0, b: 0});
    let setKey;
    function App() {
      const [key, _setKey] = useState('a');
      setKey = _setKey;
      return <Text text={key + useStore(store, s => s[key])} />;
    }

    const root = ReactNoop.createRoot();
    await act(() => root.render(<App />));
    assertLog(['a0']);

    // The selected slice does not change, so nothing renders.
    await act(() => store.dispatch(s => ({...s, b: 1})));
    assertLog([]);

    await act(() => setKey('b'));
    assertLog(['b1']);
    expect(root).toMatchRenderedOutput('b1');
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
  it('reads the state on screen when a selector changes during a pending Transition', async () => {
    const store = createStore({a: 0, b: 0});
    let setKey;
    function Full() {
      const state = useStore(store);
      if (state.a === 10) {
        readText('a10');
      }
      return <Text text={'full:' + state.a + ',' + state.b} />;
    }
    function Slice() {
      const [key, _setKey] = useState('b');
      setKey = _setKey;
      return <Text text={'slice:' + key + useStore(store, s => s[key])} />;
    }

    const root = ReactNoop.createRoot();
    await act(() =>
      root.render(
        <Suspense fallback={<Text text="Loading" />}>
          <Full />
          <Slice />
        </Suspense>,
      ),
    );
    assertLog(['full:0,0', 'slice:b0']);

    await act(() =>
      startTransition(() => store.dispatch(s => ({...s, a: 10}))),
    );
    assertLog(['Loading']);

    // The Slice reader skipped the Transition. Switching it to `a` in a
    // blocking update reads the state on screen, not the pending one.
    await act(() =>
      flushSync(() => {
        setKey('a');
        store.dispatch(s => ({...s, b: 1}));
      }),
    );
    // The Transition renders again and suspends; it does not commit.
    assertLog(['full:0,1', 'slice:a0', 'slice:a10', 'Loading']);
    expect(root).toMatchRenderedOutput('full:0,1slice:a0');
  });

  async function renderTwoTransitions(createStateSource) {
    const reducer = (state, action) => ({...state, [action.key]: action.value});
    const initial = {a: 'A0', b: 'B0'};
    const [useTestState, dispatch] = createStateSource(reducer, initial);
    function App() {
      const state = useTestState();
      return (
        <>
          <Suspense fallback={<Text text="Loading" />}>
            {state.a === 'A0' ? (
              <Text text={state.a} />
            ) : (
              <AsyncText text={state.a} />
            )}
          </Suspense>
          <Text text={state.b} />
        </>
      );
    }
    textCache = new Map();
    const root = ReactNoop.createRoot();
    const outputs = [];
    const step = async callback => {
      await act(callback);
      Scheduler.unstable_clearLog();
      outputs.push(root.getChildrenAsJSX());
    };
    await step(() => root.render(<App />));
    await step(() => startTransition(() => dispatch({key: 'a', value: 'A1'})));
    await step(() => startTransition(() => dispatch({key: 'b', value: 'B1'})));
    await step(() => dispatch({key: 'b', value: 'B2'}));
    await step(() => resolveText('A1'));
    return outputs;
  }

  // @gate enableStore
  it('matches useReducer when two Transitions are pending', async () => {
    const withReducer = await renderTwoTransitions((reducer, initial) => {
      let dispatchRef;
      return [
        () => {
          const [state, dispatch] = React.useReducer(reducer, initial);
          dispatchRef = dispatch;
          return state;
        },
        action => dispatchRef(action),
      ];
    });
    const withStore = await renderTwoTransitions((reducer, initial) => {
      const store = createStore(initial, reducer);
      return [() => useStore(store), store.dispatch];
    });
    expect(withStore).toEqual(withReducer);
  });

  // @gate enableStore
  it('catches up a root that did not render the Transition once it commits', async () => {
    const store = createStore(0, (n, by) => n + by);
    function Stalls() {
      const n = useStore(store);
      if (n >= 10) {
        readText('data');
      }
      return <Text text={'b' + n} />;
    }
    function Late() {
      return <Text text={'c' + useStore(store)} />;
    }

    const rootB = ReactNoop.createRoot();
    await act(() =>
      rootB.render(
        <Suspense fallback={<Text text="Loading" />}>
          <Stalls />
        </Suspense>,
      ),
    );
    assertLog(['b0']);

    await act(() => startTransition(() => store.dispatch(10)));
    assertLog(['Loading']);

    // A root that mounts while root B is behind shows the state before the
    // Transition.
    const rootC = ReactNoop.createRoot();
    await act(() => rootC.render(<Late />));
    assertLog(['c0']);

    await act(() => resolveText('data'));
    assertLog(['b10', 'c10']);
    expect(rootB).toMatchRenderedOutput('b10');
    expect(rootC).toMatchRenderedOutput('c10');
  });

  // @gate enableStore && !disableLegacyMode
  it('renders a Transition synchronously in a legacy root', async () => {
    const store = createStore(0);
    function App() {
      return <Text text={String(useStore(store))} />;
    }

    const root = ReactNoop.createLegacyRoot();
    await act(() => root.render(<App />));
    assertLog(['0']);

    await act(() => startTransition(() => store.dispatch(1)));
    assertLog(['1']);
    expect(root).toMatchRenderedOutput('1');
  });

  // @gate enableStore
  it('shows actions dispatched while hidden when an Activity is revealed', async () => {
    const store = createStore(0);
    function Reader() {
      return <Text text={String(useStore(store))} />;
    }
    function App({mode}) {
      return (
        <Activity mode={mode}>
          <Reader />
        </Activity>
      );
    }

    const root = ReactNoop.createRoot();
    await act(() => root.render(<App mode="visible" />));
    assertLog(['0']);

    await act(() => root.render(<App mode="hidden" />));
    assertLog(['0']);
    await act(() => store.dispatch(1));
    assertLog([]);

    await act(() => root.render(<App mode="visible" />));
    assertLog(['1']);
    expect(root).toMatchRenderedOutput('1');
  });

  // @gate enableStore
  it('shows the latest state when an Activity is revealed with updates still queued', async () => {
    const store = createStore(0);
    function Reader() {
      return <Text text={String(useStore(store))} />;
    }
    function App({mode}) {
      return (
        <Activity mode={mode}>
          <Reader />
        </Activity>
      );
    }

    const root = ReactNoop.createRoot();
    await act(() => root.render(<App mode="visible" />));
    assertLog(['0']);

    await act(() => {
      // The reader queues 1, then is hidden before it renders it.
      flushSync(() => {
        store.dispatch(1);
        root.render(<App mode="hidden" />);
      });
      store.dispatch(2);
      flushSync(() => root.render(<App mode="visible" />));
    });
    assertLog(['2']);
    expect(root).toMatchRenderedOutput('2');
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
  it('notifies subscribers with the dispatched action', () => {
    const store = createStore(0, (n, action) => n + action.by);
    const actions = [];
    const unsubscribe = store.subscribe(action => actions.push(action));
    store.dispatch({by: 2});
    unsubscribe();
    store.dispatch({by: 3});
    expect(actions).toEqual([{by: 2}]);
    expect(store.getState()).toBe(5);
  });

  // @gate enableStore
  it('applies an action that only changes the state on screen', async () => {
    const store = createStore('A');
    function App() {
      const text = useStore(store);
      return text === 'B' ? <AsyncText text="B" /> : <Text text={text} />;
    }

    const root = ReactNoop.createRoot();
    await act(() =>
      root.render(
        <Suspense fallback={<Text text="Loading" />}>
          <App />
        </Suspense>,
      ),
    );
    assertLog(['A']);

    await act(() => startTransition(() => store.dispatch('B')));
    assertLog(['Loading']);

    // The latest state is already B, but the state on screen is not.
    await act(() => store.dispatch('B'));
    assertLog(['Loading']);
    expect(root).toMatchRenderedOutput('Loading');
  });

  // @gate enableStore
  it('does not select the pending state during a blocking render', async () => {
    const store = createStore(0);
    let setLabel;
    function App() {
      const [label, _setLabel] = useState('a');
      setLabel = _setLabel;
      const value = useStore(store, n => {
        if (n === 1) {
          readText('one');
        }
        return n;
      });
      return <Text text={label + value} />;
    }

    const root = ReactNoop.createRoot();
    await act(() =>
      root.render(
        <Suspense fallback={<Text text="Loading" />}>
          <App />
        </Suspense>,
      ),
    );
    assertLog(['a0']);

    await act(() => startTransition(() => store.dispatch(1)));
    assertLog(['Loading']);

    await act(() => setLabel('b'));
    assertLog(['b0', 'Loading']);
    expect(root).toMatchRenderedOutput('b0');
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

  // @gate enableStore
  it('mounts a reader in the same Transition as a dispatch in another root', async () => {
    const store = createStore(0);
    function Stalls() {
      const n = useStore(store);
      if (n >= 10) {
        readText('data');
      }
      return <Text text={'a' + n} />;
    }
    let showReader;
    function NewReader() {
      return <Text text={'b' + useStore(store)} />;
    }
    function App() {
      const [show, setShow] = useState(false);
      showReader = setShow;
      return show ? <NewReader /> : <Text text="b-" />;
    }

    const rootA = ReactNoop.createRoot();
    const rootB = ReactNoop.createRoot();
    await act(() => {
      rootA.render(
        <Suspense fallback={<Text text="Loading" />}>
          <Stalls />
        </Suspense>,
      );
      rootB.render(<App />);
    });
    assertLog(['a0', 'b-']);

    await act(() =>
      startTransition(() => {
        store.dispatch(10);
        showReader(true);
      }),
    );
    // Root B commits the Transition, so its new reader shows the dispatch.
    assertLog(['Loading', 'b10']);
    expect(rootA).toMatchRenderedOutput('a0');
    expect(rootB).toMatchRenderedOutput('b10');
  });

  // @gate enableStore
  it('does not expose a readerless Transition to a blocking mount', async () => {
    const store = createStore(0);
    let setPage;
    function Page() {
      const [page, _setPage] = useState('home');
      setPage = _setPage;
      return page === 'home' ? <Text text="home" /> : <AsyncText text={page} />;
    }
    let showReader;
    function Reader() {
      return <Text text={'n' + useStore(store)} />;
    }
    function Other() {
      const [show, setShow] = useState(false);
      showReader = setShow;
      return show ? <Reader /> : <Text text="n-" />;
    }

    const root = ReactNoop.createRoot();
    await act(() =>
      root.render(
        <>
          <Suspense fallback={<Text text="Loading" />}>
            <Page />
          </Suspense>
          <Other />
        </>,
      ),
    );
    assertLog(['home', 'n-']);

    // Nothing reads the store yet. The Transition that updates it waits on
    // data.
    await act(() =>
      startTransition(() => {
        store.dispatch(10);
        setPage('about');
      }),
    );
    assertLog(['Loading']);

    // A blocking render mounts a reader. The Transition has not committed.
    await act(() => showReader(true));
    // The new reader also renders with the Transition, which does not commit.
    assertLog(['n0', 'Loading', 'n10']);
    expect(root).toMatchRenderedOutput('homen0');

    await act(() => resolveText('about'));
    assertLog(['about', 'n10']);
    expect(root).toMatchRenderedOutput('aboutn10');
  });

  // @gate enableStore && enableGestureTransition
  it('throws like setState when dispatching inside a gesture Transition', async () => {
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
      'Cannot setState on regular state inside a startGestureTransition.',
    );
    // Nothing changed, so nothing renders.
    expect(store.getState()).toBe(0);
    await act(() => {});
    assertLog([]);
    expect(root).toMatchRenderedOutput('0');
  });

  // @gate enableStore
  it('shows a Transition dispatched before its scope throws', async () => {
    const store = createStore(0);
    function App() {
      return <Text text={String(useStore(store))} />;
    }
    const root = ReactNoop.createRoot();
    await act(() => root.render(<App />));
    assertLog(['0']);

    await act(() => {
      startTransition(() => {
        store.dispatch(1);
        throw new Error('Oops');
      });
    });
    assertLog(['reportError: Oops', '1']);
    expect(root).toMatchRenderedOutput('1');
  });

  // @gate enableStore
  it('does not expose a nested Transition before the outer one commits', async () => {
    const store = createStore(0);
    let setPage;
    function Page() {
      const [page, _setPage] = useState('home');
      setPage = _setPage;
      return page === 'home' ? <Text text="home" /> : <AsyncText text={page} />;
    }
    function Reader() {
      return <Text text={'n' + useStore(store)} />;
    }
    const rootA = ReactNoop.createRoot();
    await act(() =>
      rootA.render(
        <Suspense fallback={<Text text="Loading" />}>
          <Page />
        </Suspense>,
      ),
    );
    assertLog(['home']);

    await act(() =>
      startTransition(() => {
        startTransition(() => store.dispatch(1));
        setPage('about');
      }),
    );
    assertLog(['Loading']);

    // Root A is still waiting on the Transition, so a new reader elsewhere
    // shows the state from before it.
    const rootB = ReactNoop.createRoot();
    await act(() => rootB.render(<Reader />));
    assertLog(['n0']);
    expect(rootB).toMatchRenderedOutput('n0');
  });

  // @gate enableStore
  it('queues no more microtasks than useState for a Transition', async () => {
    let setCount;
    function StateReader() {
      const [count, _setCount] = useState(0);
      setCount = _setCount;
      return <Text text={'state' + count} />;
    }
    const store = createStore(0);
    function StoreReader() {
      return <Text text={'store' + useStore(store)} />;
    }
    const root = ReactNoop.createRoot();
    root.render(
      <>
        <StateReader />
        <StoreReader />
      </>,
    );
    await waitForAll(['state0', 'store0']);

    microtaskCount = 0;
    startTransition(() => setCount(1));
    await waitForAll(['state1']);
    const withState = microtaskCount;
    expect(withState).toBeGreaterThan(0);

    microtaskCount = 0;
    startTransition(() => store.dispatch(1));
    await waitForAll(['store1']);
    expect(microtaskCount).toBe(withState);

    // Nothing reads this store, but the scheduling pass still settles it: one
    // microtask, as for any update.
    const unread = createStore(0);
    microtaskCount = 0;
    startTransition(() => unread.dispatch(1));
    await waitForAll([]);
    expect(microtaskCount).toBe(1);
  });

  // @gate enableStore
  it('mounts a reader with flushSync in the same event as a Transition dispatch', async () => {
    const store = createStore(0);
    let setPage;
    function Page() {
      const [page, _setPage] = useState('home');
      setPage = _setPage;
      return page === 'home' ? <Text text="home" /> : <AsyncText text={page} />;
    }
    let showReader;
    function Reader() {
      return <Text text={'n' + useStore(store)} />;
    }
    function Other() {
      const [show, setShow] = useState(false);
      showReader = setShow;
      return show ? <Reader /> : <Text text="n-" />;
    }
    const root = ReactNoop.createRoot();
    await act(() =>
      root.render(
        <>
          <Suspense fallback={<Text text="Loading" />}>
            <Page />
          </Suspense>
          <Other />
        </>,
      ),
    );
    assertLog(['home', 'n-']);

    await act(() => {
      startTransition(() => {
        store.dispatch(10);
        setPage('about');
      });
      flushSync(() => showReader(true));
    });
    // The reader mounts before the Transition, then renders with it.
    assertLog(['n0', 'Loading', 'n10']);
    expect(root).toMatchRenderedOutput('homen0');
  });

  // @gate enableStore
  it('holds a store update inside an async Action until the Action finishes', async () => {
    const store = createStore(2, (n, action) =>
      action === 'double' ? n * 2 : n + 1,
    );
    function App() {
      return <Text text={String(useStore(store))} />;
    }
    const root = ReactNoop.createRoot();
    await act(() => root.render(<App />));
    assertLog(['2']);

    let finishAction;
    await act(() =>
      startTransition(async () => {
        store.dispatch('double');
        await new Promise(resolve => (finishAction = resolve));
      }),
    );
    Scheduler.unstable_clearLog();
    // Like useState, the Action's update waits for the Action.
    expect(root).toMatchRenderedOutput('2');

    // A blocking update applies to the state on screen.
    await act(() => store.dispatch('increment'));
    Scheduler.unstable_clearLog();
    expect(root).toMatchRenderedOutput('3');

    await act(() => finishAction());
    Scheduler.unstable_clearLog();
    expect(root).toMatchRenderedOutput('5');
    expect(store.getState()).toBe(5);
    Scheduler.unstable_clearLog();
  });
});
