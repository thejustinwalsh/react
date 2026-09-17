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
let ReactNoopSecondary;
let Scheduler;
let act;
let assertLog;
let createStore;
let useStore;
let useState;
let startTransition;
let Suspense;
let textCache;

describe('useStore in multiple renderers', () => {
  afterEach(() => {
    global.__unmockReact();
    jest.mock('scheduler', () => jest.requireActual('scheduler/unstable_mock'));
  });

  beforeEach(() => {
    jest.resetModules();

    React = require('react');
    Scheduler = require('scheduler');
    ReactNoop = require('react-noop-renderer');
    const ReactSharedInternals = require('shared/ReactSharedInternals');
    const InternalTestUtils = require('internal-test-utils');
    act = InternalTestUtils.act;
    assertLog = InternalTestUtils.assertLog;

    // A second copy of the reconciler, sharing React, like two renderers on a
    // page.
    jest.resetModules();
    jest.doMock('react', () => React);
    jest.doMock('scheduler', () => Scheduler);
    jest.doMock('shared/ReactSharedInternals', () => ReactSharedInternals);
    ReactNoopSecondary = require('react-noop-renderer');

    createStore = React.createStore;
    useStore = React.useStore;
    useState = React.useState;
    startTransition = React.startTransition;
    Suspense = React.Suspense;
    textCache = new Map();
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
  it('hands a Transition to a renderer with no readers while another renderer has one', async () => {
    const store = createStore(0);
    function Reader({name}) {
      return <Text text={name + useStore(store)} />;
    }
    let setPage;
    function Page() {
      const [page, _setPage] = useState('home');
      setPage = _setPage;
      return page === 'home' ? <Text text="home" /> : <AsyncText text={page} />;
    }
    let showReader;
    function Other() {
      const [show, setShow] = useState(false);
      showReader = setShow;
      return show ? <Reader name="b" /> : <Text text="b-" />;
    }

    const rootA = ReactNoop.createRoot();
    const rootB = ReactNoopSecondary.createRoot();
    await act(() => {
      rootA.render(<Reader name="a" />);
      rootB.render(
        <>
          <Suspense fallback={<Text text="Loading" />}>
            <Page />
          </Suspense>
          <Other />
        </>,
      );
    });
    assertLog(['a0', 'home', 'b-']);

    await act(() =>
      startTransition(() => {
        store.dispatch(10);
        setPage('about');
      }),
    );
    assertLog(['a10', 'Loading']);
    expect(rootA).toMatchRenderedOutput('a10');

    // Root B's Transition has not committed, so a reader it mounts in a
    // blocking render does not show the action yet.
    await act(() => showReader(true));
    assertLog(['b0', 'Loading', 'b10']);
    expect(rootB).toMatchRenderedOutput('homeb0');

    await act(() => resolveText('about'));
    assertLog(['about', 'b10']);
    expect(rootB).toMatchRenderedOutput('aboutb10');
  });

  // @gate enableStore
  it('rejects a dispatch while rendering before any renderer receives it', async () => {
    const store = createStore(0);
    function Reader() {
      return <Text text={'a' + useStore(store)} />;
    }
    let dispatchWhileRendering = false;
    function Dispatches() {
      const n = useStore(store);
      if (dispatchWhileRendering) {
        store.dispatch(1);
      }
      return <Text text={'b' + n} />;
    }

    const rootA = ReactNoop.createRoot();
    const rootB = ReactNoopSecondary.createRoot();
    await act(() => {
      rootA.render(<Reader />);
      rootB.render(<Dispatches />);
    });
    assertLog(['a0', 'b0']);

    dispatchWhileRendering = true;
    await expect(
      act(() => rootB.render(<Dispatches key="again" />)),
    ).rejects.toThrow('Cannot dispatch to a store while rendering.');
    dispatchWhileRendering = false;
    expect(store.getState()).toBe(0);

    await act(() => rootA.render(<Reader key="again" />));
    assertLog(['a0']);
    expect(rootA).toMatchRenderedOutput('a0');
  });
});
