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
let Suspense;
let textCache;

describe('useStore in multiple roots', () => {
  beforeEach(() => {
    jest.resetModules();

    React = require('react');
    ReactNoop = require('react-noop-renderer');
    Scheduler = require('scheduler');
    createStore = React.createStore;
    useStore = React.useStore;
    useState = React.useState;
    startTransition = React.startTransition;
    Suspense = React.Suspense;
    textCache = new Map();

    const InternalTestUtils = require('internal-test-utils');
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
  it('shows a Transition in a root that mounts with no work pending for it', async () => {
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

    // Roots are independent: one that has no work pending for the Transition
    // shows it while root B still waits on it.
    const rootC = ReactNoop.createRoot();
    await act(() => rootC.render(<Late />));
    assertLog(['c10']);

    await act(() => resolveText('data'));
    assertLog(['b10']);
    expect(rootB).toMatchRenderedOutput('b10');
    expect(rootC).toMatchRenderedOutput('c10');
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
  it('mounts a reader at the state its root shows after it committed a Transition another root has not', async () => {
    const store = createStore(0);
    function Stalls() {
      const n = useStore(store);
      if (n >= 10) {
        readText('data');
      }
      return <Text text={'a' + n} />;
    }
    function StallsLater() {
      const n = useStore(store);
      if (n >= 20) {
        readText('more');
      }
      return <Text text={'b' + n} />;
    }
    let showReader;
    function NewReader() {
      return <Text text={'new' + useStore(store)} />;
    }
    function App() {
      const [show, setShow] = useState(false);
      showReader = setShow;
      return (
        <>
          <StallsLater />
          {show ? <NewReader /> : null}
        </>
      );
    }

    const rootA = ReactNoop.createRoot();
    const rootB = ReactNoop.createRoot();
    await act(() => {
      rootA.render(<Stalls />);
      rootB.render(<App />);
    });
    assertLog(['a0', 'b0']);

    // Root B commits the first Transition. Root A waits for data.
    await act(() => startTransition(() => store.dispatch(10)));
    assertLog(['b10']);
    expect(rootA).toMatchRenderedOutput('a0');
    expect(rootB).toMatchRenderedOutput('b10');

    // Both roots wait on the second.
    await act(() => startTransition(() => store.dispatch(20)));
    assertLog([]);
    expect(rootA).toMatchRenderedOutput('a0');
    expect(rootB).toMatchRenderedOutput('b10');

    // A blocking mount in root B shows what root B shows.
    await act(() => showReader(true));
    assertLog(['b10', 'new10', 'new20']);
    expect(rootB).toMatchRenderedOutput('b10new10');
  });

  // @gate enableStore
  it('waits for the outer Transition to show a nested one only in the roots it renders', async () => {
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

    // Root A is still waiting on the Transition. Root B has no work pending
    // for it, so it shows it.
    const rootB = ReactNoop.createRoot();
    await act(() => rootB.render(<Reader />));
    assertLog(['n1']);
    expect(rootB).toMatchRenderedOutput('n1');
  });

  // @gate enableStore
  it('shows an async Action in a root that mounted during it once it finishes', async () => {
    const store = createStore(0);
    function Reader({name}) {
      return <Text text={name + useStore(store)} />;
    }

    const rootA = ReactNoop.createRoot();
    await act(() => rootA.render(<Reader name="a" />));
    assertLog(['a0']);

    let finishAction;
    await act(() =>
      startTransition(async () => {
        store.dispatch(1);
        await new Promise(resolve => (finishAction = resolve));
      }),
    );
    assertLog([]);
    expect(rootA).toMatchRenderedOutput('a0');

    // Like an update in the Action, the action is not shown before the Action
    // finishes.
    const rootB = ReactNoop.createRoot();
    await act(() => rootB.render(<Reader name="b" />));
    assertLog(['b0']);
    expect(rootB).toMatchRenderedOutput('b0');

    // Root B had no work pending for the Action, so it shows the action as
    // soon as the Action finishes, without waiting for root A.
    await act(() => finishAction());
    assertLog(['b1', 'a1']);
    expect(rootA).toMatchRenderedOutput('a1');
    expect(rootB).toMatchRenderedOutput('b1');
  });
});
