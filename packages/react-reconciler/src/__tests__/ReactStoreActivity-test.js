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
let Activity;
let use;
let flushSync;

describe('a store in Activity', () => {
  beforeEach(() => {
    jest.resetModules();

    React = require('react');
    ReactNoop = require('react-noop-renderer');
    Scheduler = require('scheduler');
    createStore = React.createStore;
    use = React.use;
    Activity = React.Activity;
    use = React.use;
    flushSync = ReactNoop.flushSync;

    const InternalTestUtils = require('internal-test-utils');
    act = InternalTestUtils.act;
    assertLog = InternalTestUtils.assertLog;
  });

  function Text({text}) {
    Scheduler.log(text);
    return text;
  }

  // @gate enableStore
  it('shows actions dispatched while hidden when an Activity is revealed', async () => {
    const store = createStore(0);
    function Reader() {
      return <Text text={String(use(store))} />;
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
      return <Text text={String(use(store))} />;
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
  it('shows actions dispatched while hidden when an Activity with a use() reader is revealed', async () => {
    const store = createStore(0);
    function Reader() {
      return <Text text={String(use(store))} />;
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
    // Hidden, so the reader is not subscribed and nothing renders.
    await act(() => store.dispatch(1));
    assertLog([]);

    await act(() => root.render(<App mode="visible" />));
    assertLog(['1']);
    expect(root).toMatchRenderedOutput('1');

    // Subscribed again once revealed.
    await act(() => store.dispatch(2));
    assertLog(['2']);
    expect(root).toMatchRenderedOutput('2');
  });
});
