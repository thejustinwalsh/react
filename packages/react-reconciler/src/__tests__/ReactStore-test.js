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
let createStoreSelector;
let useState;
let startTransition;
let use;
let Suspense;
let promises;

describe('createStore and use', () => {
  beforeEach(() => {
    jest.resetModules();
    global.reportError = error => {
      Scheduler.log('reportError: ' + error.message);
    };

    React = require('react');
    ReactNoop = require('react-noop-renderer');
    Scheduler = require('scheduler');
    createStore = React.createStore;
    createStoreSelector = React.createStoreSelector;
    use = React.use;
    useState = React.useState;
    startTransition = React.startTransition;
    use = React.use;
    Suspense = React.Suspense;
    promises = new Map();

    const InternalTestUtils = require('internal-test-utils');
    act = InternalTestUtils.act;
    assertLog = InternalTestUtils.assertLog;
  });

  const textCache = new Map();
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
      return <Text text={String(use(store))} />;
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
      return <Text text={String(use(store))} />;
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
      return <Text text={String(use(store))} />;
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
    const a = store.select(state => state.a);
    const b = store.select(state => state.b);
    function A() {
      return <Text text={'a' + use(a)} />;
    }
    function B() {
      return <Text text={'b' + use(b)} />;
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
    const items = store.select((state, previous) =>
      previous !== undefined &&
      previous.length === state.items.length &&
      previous.every((item, i) => item === state.items[i])
        ? previous
        : state.items.slice(),
    );
    const selections = [];
    function App() {
      const selected = use(items);
      selections.push(selected);
      return <Text text={selected.join(',')} />;
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
    const previousValues = [];
    const track = (state, previous) => {
      previousValues.push(previous);
      return state;
    };
    const first = createStore(1);
    const second = createStore(2);
    const firstSelection = first.select(track);
    const secondSelection = second.select(track);
    let setSelection;
    function App() {
      const [selection, _setSelection] = useState(firstSelection);
      setSelection = _setSelection;
      return <Text text={String(use(selection))} />;
    }

    const root = ReactNoop.createRoot();
    await act(() => root.render(<App />));
    assertLog(['1']);
    previousValues.length = 0;

    await act(() => setSelection(secondSelection));
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
    const fields = {a: store.select(s => s.a), b: store.select(s => s.b)};
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
      const value = use(fields[field]);
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
    const selections = [first.select(s => s.a), second.select(s => s.a)];
    function Reader({which}) {
      return <Text text={'a=' + use(selections[which])} />;
    }
    const root = ReactNoop.createRoot();
    await act(() => root.render(<Reader which={0} />));
    assertLog(['a=0']);
    await act(() => root.render(<Reader which={1} />));
    assertLog(['a=0']);

    await act(() => second.dispatch(s => ({...s, b: 1})));
    assertLog([]);
    await act(() => second.dispatch(s => ({...s, a: 1})));
    assertLog(['a=1']);
  });

  // @gate enableStore
  it('does not commit a reader for a change it does not select', async () => {
    const store = createStore({unread: 0, theme: 'dark'});
    const unreadCount = store.select(s => s.unread);
    let commits = 0;
    function Unread() {
      const unread = use(unreadCount);
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
    const checked = store.select(n => {
      if (n > 0) {
        throw new Error('Oops');
      }
      return n;
    });
    function App() {
      const value = use(checked);
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
    const keepOne = (state, previous) => (previous === 1 ? previous : state);
    const first = createStore(1);
    const second = createStore(undefined);
    const selections = [first.select(keepOne), second.select(keepOne)];
    let setSelection;
    function App() {
      const [which, _setSelection] = useState(0);
      setSelection = _setSelection;
      return <Text text={String(use(selections[which]))} />;
    }

    const root = ReactNoop.createRoot();
    await act(() => root.render(<App />));
    assertLog(['1']);

    await act(() => setSelection(1));
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
      return <Text text={String(use(store))} />;
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
      return <Text text={String(use(store))} />;
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
      return <Text text={String(use(store))} />;
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
    const count = store.select(selector);
    function App() {
      return <Text text={'n' + use(count)} />;
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
  it('gives the promise a store holds to use(), which resolves it', async () => {
    const store = createStore(getPromise('first'));
    function App() {
      // use(store) is the promise the store holds, like a context of one.
      return <Text text={use(use(store))} />;
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

  // @gate enableStore
  it('reads a store with use() inside a condition', async () => {
    const store = createStore(0, (n, by) => n + by);
    let setShow;
    function App() {
      const [show, _setShow] = useState(true);
      setShow = _setShow;
      return <Text text={'n' + (show ? use(store) : '-')} />;
    }
    const root = ReactNoop.createRoot();
    await act(() => root.render(<App />));
    assertLog(['n0']);

    await act(() => store.dispatch(1));
    assertLog(['n1']);

    // Stops reading the store.
    await act(() => setShow(false));
    assertLog(['n-']);
    await act(() => store.dispatch(1));
    assertLog([]);
    expect(root).toMatchRenderedOutput('n-');

    // Reads it again, at the state it has now.
    await act(() => setShow(true));
    assertLog(['n2']);
    expect(root).toMatchRenderedOutput('n2');
  });

  // @gate enableStore
  it('reads a store with use() in a loop', async () => {
    const store = createStore({a: 0, b: 0}, (state, key) => ({
      ...state,
      [key]: state[key] + 1,
    }));
    function App({keys}) {
      const state = use(store);
      return (
        <>
          {keys.map(key => (
            <Text key={key} text={key + state[key]} />
          ))}
        </>
      );
    }
    const root = ReactNoop.createRoot();
    await act(() => root.render(<App keys={['a', 'b']} />));
    assertLog(['a0', 'b0']);

    await act(() => store.dispatch('a'));
    assertLog(['a1', 'b0']);
    expect(root).toMatchRenderedOutput('a1b0');
  });

  // @gate enableStore
  it('reads a selection of a store', async () => {
    const store = createStore({count: 0, other: 'a'}, (state, action) => ({
      ...state,
      ...action,
    }));
    const count = store.select(state => state.count);
    function App() {
      return <Text text={'n' + use(count)} />;
    }
    const root = ReactNoop.createRoot();
    await act(() => root.render(<App />));
    assertLog(['n0']);
    expect(count.getState()).toBe(0);

    await act(() => store.dispatch({count: 1}));
    assertLog(['n1']);
    expect(root).toMatchRenderedOutput('n1');

    // Nothing this selection covers changed.
    await act(() => store.dispatch({other: 'b'}));
    assertLog([]);
    expect(root).toMatchRenderedOutput('n1');
  });

  // @gate enableStore
  it('refines a selection with another selection', async () => {
    const store = createStore({rows: {a: 1, b: 2}}, (state, action) => ({
      rows: {...state.rows, ...action},
    }));
    const rows = store.select(state => state.rows);
    const a = rows.select(state => state.a);
    function App() {
      return <Text text={'a' + use(a)} />;
    }
    const root = ReactNoop.createRoot();
    await act(() => root.render(<App />));
    assertLog(['a1']);

    await act(() => store.dispatch({b: 3}));
    assertLog([]);
    await act(() => store.dispatch({a: 9}));
    assertLog(['a9']);
    expect(root).toMatchRenderedOutput('a9');
  });

  // @gate enableStore
  it('passes the previous selection to a select function', async () => {
    const store = createStore({ids: [1, 2], version: 0}, (state, action) => ({
      ...state,
      ...action,
    }));
    const ids = store.select((state, previous) => {
      const next = state.ids;
      // Structural sharing: keep the identity a reader already rendered.
      if (
        previous !== undefined &&
        previous.length === next.length &&
        previous.every((id, i) => id === next[i])
      ) {
        return previous;
      }
      return next;
    });
    let renders = 0;
    function App() {
      renders++;
      return <Text text={use(ids).join(',')} />;
    }
    const root = ReactNoop.createRoot();
    await act(() => root.render(<App />));
    assertLog(['1,2']);
    expect(renders).toBe(1);

    // A new array with the same ids does not re-render.
    await act(() => store.dispatch({ids: [1, 2], version: 1}));
    assertLog([]);
    expect(renders).toBe(1);

    await act(() => store.dispatch({ids: [1, 2, 3]}));
    assertLog(['1,2,3']);
    expect(renders).toBe(2);
  });

  // @gate enableStore
  it('reads a selection per item in a loop', async () => {
    const store = createStore({a: 0, b: 0}, (state, key) => ({
      ...state,
      [key]: state[key] + 1,
    }));
    const selections = new Map();
    function selectionFor(key) {
      let selection = selections.get(key);
      if (selection === undefined) {
        selection = store.select(state => state[key]);
        selections.set(key, selection);
      }
      return selection;
    }
    function Row({item}) {
      return <Text text={item + use(selectionFor(item))} />;
    }
    function App() {
      return (
        <>
          {['a', 'b'].map(item => (
            <Row key={item} item={item} />
          ))}
        </>
      );
    }
    const root = ReactNoop.createRoot();
    await act(() => root.render(<App />));
    assertLog(['a0', 'b0']);

    // Only the row whose selection changed renders.
    await act(() => store.dispatch('a'));
    assertLog(['a1']);
    expect(root).toMatchRenderedOutput('a1b0');
  });

  // @gate enableStore
  it('throws when a selection is dispatched to', async () => {
    const store = createStore(0);
    const selection = store.select(state => state);
    expect(() => selection.dispatch(1)).toThrow(
      'Cannot dispatch to a selection of a store. Dispatch to the store it ' +
        'was selected from.',
    );
  });

  // @gate enableStore
  it('gives a new selection at the same read the value that read committed', async () => {
    const store = createStore({ids: [1, 2], other: 0});
    const sameIds = (previous, next) =>
      previous !== undefined &&
      previous.length === next.length &&
      previous.every((id, i) => id === next[i]);
    const selections = [];
    function App() {
      // A new selection every render, like a binding given an inline selector.
      const ids = use(
        store.select((state, previous) =>
          sameIds(previous, state.ids) ? previous : state.ids.slice(),
        ),
      );
      selections.push(ids);
      return <Text text={ids.join(',')} />;
    }
    let setLabel;
    function Wrapper() {
      const [label, _setLabel] = useState('a');
      setLabel = _setLabel;
      return (
        <>
          <Text text={label} />
          <App />
        </>
      );
    }

    const root = ReactNoop.createRoot();
    await act(() => root.render(<Wrapper />));
    assertLog(['a', '1,2']);
    expect(selections.length).toBe(1);

    // The parent renders again, so the reader gets a new selection. It keeps
    // the identity it rendered, because the previous value comes from the read.
    await act(() => setLabel('b'));
    assertLog(['b', '1,2']);
    expect(selections.length).toBe(2);
    expect(selections[1]).toBe(selections[0]);

    // A change the selection covers is a new array.
    await act(() => store.dispatch(state => ({...state, ids: [1, 2, 3]})));
    assertLog(['1,2,3']);
    expect(selections[2]).not.toBe(selections[1]);
  });

  // @gate enableStore
  it('reads a selection of two stores', async () => {
    const price = createStore(2);
    const quantity = createStore(3);
    const total = createStoreSelector([price, quantity], ([p, q]) => p * q);
    let renders = 0;
    function App() {
      renders++;
      return <Text text={'total:' + use(total)} />;
    }
    const root = ReactNoop.createRoot();
    await act(() => root.render(<App />));
    assertLog(['total:6']);
    expect(total.getState()).toBe(6);

    await act(() => price.dispatch(4));
    assertLog(['total:12']);

    await act(() => quantity.dispatch(1));
    assertLog(['total:4']);
    expect(renders).toBe(3);

    // Neither source changed what it selects.
    await act(() => price.dispatch(4));
    assertLog([]);
    expect(renders).toBe(3);
  });

  // @gate enableStore
  it('commits a Transition that dispatches to both stores of a selection', async () => {
    const price = createStore(2);
    const quantity = createStore(3);
    const total = createStoreSelector([price, quantity], ([p, q]) => p * q);
    function App() {
      const value = use(total);
      if (value >= 20) {
        readText('big');
      }
      return <Text text={'total:' + value} />;
    }
    const root = ReactNoop.createRoot();
    await act(() =>
      root.render(
        <Suspense fallback={<Text text="Loading" />}>
          <App />
        </Suspense>,
      ),
    );
    assertLog(['total:6']);

    // Both dispatches share the Transition, so the selection never sees one
    // without the other.
    await act(() =>
      startTransition(() => {
        price.dispatch(5);
        quantity.dispatch(5);
      }),
    );
    assertLog(['Loading']);
    expect(root).toMatchRenderedOutput('total:6');

    await act(() => resolveText('big'));
    assertLog(['total:25']);
    expect(root).toMatchRenderedOutput('total:25');
  });

  // @gate enableStore
  it('rebases a blocking dispatch to one store over a pending Transition in another', async () => {
    const page = createStore('home');
    const count = createStore(0);
    const label = createStoreSelector(
      [page, count],
      ([currentPage, n]) => currentPage + ':' + n,
    );
    function Page() {
      const current = use(page);
      if (current !== 'home') {
        readText(current);
      }
      return <Text text={use(label)} />;
    }
    const root = ReactNoop.createRoot();
    await act(() =>
      root.render(
        <Suspense fallback={<Text text="Loading" />}>
          <Page />
        </Suspense>,
      ),
    );
    assertLog(['home:0']);

    await act(() =>
      startTransition(() => {
        page.dispatch('about');
        count.dispatch(10);
      }),
    );
    assertLog(['Loading']);
    expect(root).toMatchRenderedOutput('home:0');

    // Lands on what is on screen, rebased over the Transition neither store
    // has committed.
    await act(() => count.dispatch(n => n + 1));
    assertLog(['home:1', 'Loading']);
    expect(root).toMatchRenderedOutput('home:1');

    await act(() => resolveText('about'));
    assertLog(['about:11']);
    expect(root).toMatchRenderedOutput('about:11');
  });

  // @gate enableStore
  it('refines a selection of two stores', async () => {
    const a = createStore({n: 1});
    const b = createStore({n: 2});
    const pair = createStoreSelector([a, b], ([first, second]) => ({
      sum: first.n + second.n,
      first: first.n,
    }));
    const sum = pair.select(value => value.sum);
    function App() {
      return <Text text={'sum:' + use(sum)} />;
    }
    const root = ReactNoop.createRoot();
    await act(() => root.render(<App />));
    assertLog(['sum:3']);

    await act(() => b.dispatch({n: 5}));
    assertLog(['sum:6']);
    expect(root).toMatchRenderedOutput('sum:6');
  });
});
