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
let flushSync;
let textCache;
let microtaskCount;

const originalQueueMicrotask = global.queueMicrotask;

describe('useStore in a Transition', () => {
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
    await act(() => store.dispatch(s => ({...s, count: s.count + 1})));
    assertLog(['count:1', 'Loading']);
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
    const logs = [];
    const step = async callback => {
      await act(callback);
      logs.push(Scheduler.unstable_clearLog());
      outputs.push(root.getChildrenAsJSX());
    };
    await step(() => root.render(<App />));
    await step(() => startTransition(() => dispatch({key: 'a', value: 'A1'})));
    await step(() => startTransition(() => dispatch({key: 'b', value: 'B1'})));
    await step(() => dispatch({key: 'b', value: 'B2'}));
    await step(() => resolveText('A1'));
    return {outputs, logs};
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
  it('commits a Transition that suspends on a promise in the store once it resolves', async () => {
    let resolveCount;
    function countLater(count) {
      return new Promise(resolve => {
        resolveCount = () => resolve(count);
      });
    }
    const store = createStore(countLater(0));
    let setCount;
    function Count({promise}) {
      return <Text text={'count:' + React.use(promise)} />;
    }
    function App() {
      const [count, _setCount] = useState(0);
      setCount = _setCount;
      const promise = useStore(store);
      return (
        <>
          <Text text={'clicked:' + count} />
          <Suspense fallback={<Text text="Loading" />}>
            <Count promise={promise} />
          </Suspense>
        </>
      );
    }

    const root = ReactNoop.createRoot();
    await act(() => root.render(<App />));
    assertLog(['clicked:0', 'Loading']);
    await act(() => resolveCount());
    assertLog(['count:0']);
    expect(root).toMatchRenderedOutput('clicked:0count:0');

    await act(() => {
      setCount(1);
      startTransition(() => store.dispatch(() => countLater(1)));
    });
    assertLog(['clicked:1', 'count:0', 'clicked:1', 'Loading']);
    expect(root).toMatchRenderedOutput('clicked:1count:0');

    await act(() => resolveCount());
    assertLog(['clicked:1', 'count:1']);
    expect(root).toMatchRenderedOutput('clicked:1count:1');
  });

  // @gate enableStore
  it('mounts a reader during a pending Transition at what the tree shows, and joins it', async () => {
    const store = createStore(1);
    function Gated() {
      const n = useStore(store);
      return n === 2 ? <AsyncText text="2" /> : <Text text={String(n)} />;
    }
    function Late() {
      return <Text text={'late:' + useStore(store)} />;
    }
    let setIsShown;
    function App() {
      const [isShown, _setIsShown] = useState(false);
      setIsShown = _setIsShown;
      return (
        <Suspense fallback={<Text text="loading" />}>
          <Gated />
          {isShown ? <Late /> : null}
        </Suspense>
      );
    }

    const root = ReactNoop.createRoot();
    await act(() => root.render(<App />));
    assertLog(['1']);
    await act(() => startTransition(() => store.dispatch(2)));
    assertLog(['loading']);
    expect(root).toMatchRenderedOutput('1');

    // Mounts at what the tree shows, then joins the Transition, which renders
    // again and is still waiting for data.
    await act(() => setIsShown(true));
    assertLog(['1', 'late:1', 'late:2', 'loading']);
    expect(root).toMatchRenderedOutput('1late:1');

    await act(() => resolveText('2'));
    assertLog(['2', 'late:2']);
    expect(root).toMatchRenderedOutput('2late:2');
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

    // Nothing reads this store, so the Transition schedules no work.
    const unread = createStore(0);
    microtaskCount = 0;
    startTransition(() => unread.dispatch(1));
    await waitForAll([]);
    expect(microtaskCount).toBe(0);
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
    assertLog([]);
    // Like useState, the Action's update waits for the Action.
    expect(root).toMatchRenderedOutput('2');

    // A blocking update applies to the state on screen.
    await act(() => store.dispatch('increment'));
    assertLog(['3']);
    expect(root).toMatchRenderedOutput('3');

    await act(() => finishAction());
    assertLog(['5']);
    expect(root).toMatchRenderedOutput('5');
    expect(store.getState()).toBe(5);
  });
});
