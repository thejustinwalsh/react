/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 * @jest-environment ./scripts/jest/ReactDOMServerIntegrationEnvironment
 */

'use strict';

let React;
let ReactDOMClient;
let ReactDOMServer;
let act;
let assertLog;
let Scheduler;
let createStore;
let useStore;

describe('ReactDOMUseStore', () => {
  let container;

  beforeEach(() => {
    jest.resetModules();
    React = require('react');
    ReactDOMClient = require('react-dom/client');
    ReactDOMServer = require('react-dom/server');
    Scheduler = require('scheduler');
    createStore = React.createStore;
    useStore = React.useStore;
    const InternalTestUtils = require('internal-test-utils');
    act = InternalTestUtils.act;
    assertLog = InternalTestUtils.assertLog;

    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.removeChild(container);
  });

  function Text({text}) {
    Scheduler.log(text);
    return text;
  }

  // @gate enableStore
  it('renders the store’s state on the server', () => {
    const store = createStore({count: 1});
    store.dispatch({count: 2});
    function App() {
      return <Text text={'count:' + useStore(store, s => s.count)} />;
    }
    expect(ReactDOMServer.renderToString(<App />)).toBe('count:2');
    assertLog(['count:2']);
  });

  // @gate enableStore
  it('hydrates from the state the server rendered, then shows actions dispatched before hydration', async () => {
    function createAppStore(initialState) {
      return createStore(initialState, (state, by) => ({
        count: state.count + by,
      }));
    }
    function App({store}) {
      return (
        <span>
          <Text text={'count:' + useStore(store, s => s.count)} />
        </span>
      );
    }

    const serverStore = createAppStore({count: 0});
    serverStore.dispatch(5);
    container.innerHTML = ReactDOMServer.renderToString(
      <App store={serverStore} />,
    );
    assertLog(['count:5']);
    const span = container.firstChild;

    // The client store is created from the state the server rendered, and an
    // action is dispatched before React hydrates.
    const clientStore = createAppStore(serverStore.getState());
    clientStore.dispatch(1);

    const errors = [];
    await act(() =>
      ReactDOMClient.hydrateRoot(container, <App store={clientStore} />, {
        onRecoverableError(error) {
          errors.push(error.message);
        },
      }),
    );
    // Hydration matches the server, then the reader catches up.
    assertLog(['count:5', 'count:6']);
    expect(errors).toEqual([]);
    expect(container.firstChild).toBe(span);
    expect(container.textContent).toBe('count:6');
  });
});
