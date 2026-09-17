/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 * @jest-environment node
 */

'use strict';

let React;
let ReactNoop;
let Scheduler;
let act;
let Random;

const SEED = process.env.FUZZ_TEST_SEED || 'default';

describe('ReactStoreFuzz', () => {
  beforeEach(() => {
    jest.resetModules();
    React = require('react');
    ReactNoop = require('react-noop-renderer');
    Scheduler = require('scheduler');
    act = require('internal-test-utils').act;
    Random = require('random-seed');
  });

  jest.setTimeout(20000);

  // A store and useReducer receive the same actions, in the same order and at
  // the same priority, so useReducer defines what a store may show.
  //
  // The store renders less than useReducer, and React entangles Transitions
  // based on pending work, so the store can wait on a Transition that
  // useReducer does not. It may show an earlier committed output while it
  // waits, but never an output useReducer did not commit, and once all data
  // has loaded both must be the same.
  function createFuzzer() {
    const PAGES = ['home', 'about', 'settings', 'profile'];
    const FILTERS = ['all', 'open', 'done'];
    let textCache;

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

    const initialState = {page: 'home', count: 0, filter: 'all'};

    function reducer(state, action) {
      switch (action.type) {
        case 'page':
          return state.page === action.page
            ? state
            : {...state, page: action.page};
        case 'add':
          return {...state, count: state.count + action.by};
        case 'filter':
          return state.filter === action.filter
            ? state
            : {...state, filter: action.filter};
        default:
          throw new Error('Unknown action');
      }
    }

    // Pages other than "home" read data that may not have loaded yet.
    function Page({page}) {
      if (page !== 'home') {
        readText(page);
      }
      return 'page:' + page + ' ';
    }

    function Count({count}) {
      return 'count:' + count + ' ';
    }

    function Filter({filter}) {
      return 'filter:' + filter + ' ';
    }

    function createStoreApp() {
      const store = React.createStore(initialState, reducer);
      function StorePage() {
        return <Page page={React.useStore(store, state => state.page)} />;
      }
      function StoreCount() {
        return <Count count={React.useStore(store, state => state.count)} />;
      }
      function StoreFilter() {
        return <Filter filter={React.useStore(store, state => state.filter)} />;
      }
      const app = {dispatch: store.dispatch, setExtraMounted: null, App: null};
      app.App = function StoreApp() {
        const [extraMounted, setExtraMounted] = React.useState(false);
        app.setExtraMounted = setExtraMounted;
        return (
          <>
            <React.Suspense fallback="loading ">
              <StorePage />
            </React.Suspense>
            <StoreCount />
            {extraMounted ? <StoreFilter /> : null}
          </>
        );
      };
      return app;
    }

    function createReducerApp() {
      const app = {dispatch: null, setExtraMounted: null, App: null};
      // The state lives in a child, the way a store's state lives outside the
      // component whose state mounts the extra reader.
      function StateHost({extraMounted}) {
        const [state, dispatch] = React.useReducer(reducer, initialState);
        app.dispatch = dispatch;
        return (
          <>
            <React.Suspense fallback="loading ">
              <Page page={state.page} />
            </React.Suspense>
            <Count count={state.count} />
            {extraMounted ? <Filter filter={state.filter} /> : null}
          </>
        );
      }
      app.App = function ReducerApp() {
        const [extraMounted, setExtraMounted] = React.useState(false);
        app.setExtraMounted = setExtraMounted;
        return <StateHost extraMounted={extraMounted} />;
      };
      return app;
    }

    async function run(app, steps) {
      textCache = new Map();
      const root = ReactNoop.createRoot();
      await act(() => root.render(<app.App />));
      const outputs = [root.getChildrenAsJSX()];
      const allSteps = steps.concat([
        {actions: PAGES.map(text => ({kind: 'resolve', text}))},
      ]);
      for (let i = 0; i < allSteps.length; i++) {
        await act(() => {
          const actions = allSteps[i].actions;
          for (let j = 0; j < actions.length; j++) {
            const action = actions[j];
            switch (action.kind) {
              case 'dispatch':
                app.dispatch(action.action);
                break;
              case 'transition':
                React.startTransition(() => app.dispatch(action.action));
                break;
              case 'resolve':
                resolveText(action.text);
                break;
              case 'mount':
                app.setExtraMounted(action.mounted);
                break;
              case 'transitionMount':
                React.startTransition(() =>
                  app.setExtraMounted(action.mounted),
                );
                break;
            }
          }
        });
        Scheduler.unstable_clearLog();
        outputs.push(root.getChildrenAsJSX());
      }
      return outputs;
    }

    function generateSteps(rand, count) {
      const randomAction = () => {
        switch (rand(3)) {
          case 0:
            return {type: 'page', page: PAGES[rand(PAGES.length)]};
          case 1:
            return {type: 'add', by: 1 + rand(3)};
          default:
            return {type: 'filter', filter: FILTERS[rand(FILTERS.length)]};
        }
      };
      const randomStepAction = () => {
        switch (rand(6)) {
          case 0:
            return {kind: 'dispatch', action: randomAction()};
          case 1:
          case 2:
            return {kind: 'transition', action: randomAction()};
          case 3:
            return {kind: 'resolve', text: PAGES[1 + rand(PAGES.length - 1)]};
          case 4:
            return {kind: 'mount', mounted: rand(2) === 0};
          default:
            return {kind: 'transitionMount', mounted: rand(2) === 0};
        }
      };
      const steps = [];
      for (let i = 0; i < count; i++) {
        // Sometimes several actions happen in the same event.
        const size = rand(4) === 0 ? 2 + rand(2) : 1;
        const actions = [];
        for (let j = 0; j < size; j++) {
          actions.push(randomStepAction());
        }
        steps.push({actions});
      }
      return steps;
    }

    // Returns how many steps the store showed an earlier output.
    async function testMatchesReducer(steps) {
      const expected = await run(createReducerApp(), steps);
      const actual = await run(createStoreApp(), steps);
      let lagging = 0;
      for (let i = 0; i < expected.length; i++) {
        if (actual[i] !== expected[i]) {
          if (!expected.slice(0, i).includes(actual[i])) {
            // An output useReducer never committed.
            expect(actual.slice(0, i + 1)).toEqual(expected.slice(0, i + 1));
          }
          lagging++;
        }
      }
      expect(actual[actual.length - 1]).toEqual(expected[expected.length - 1]);
      return lagging;
    }

    return {testMatchesReducer, generateSteps};
  }

  describe('hard-coded cases', () => {
    // @gate enableStore
    it('a blocking update while a Transition waits on data', async () => {
      const {testMatchesReducer} = createFuzzer();
      const lagging = await testMatchesReducer([
        {
          actions: [
            {kind: 'transition', action: {type: 'page', page: 'about'}},
          ],
        },
        {actions: [{kind: 'dispatch', action: {type: 'add', by: 1}}]},
        {actions: [{kind: 'mount', mounted: true}]},
        {actions: [{kind: 'resolve', text: 'about'}]},
      ]);
      expect(lagging).toBe(0);
    });

    // @gate enableStore
    it('a reader hidden by a fallback hears the update that reveals it', async () => {
      const {testMatchesReducer} = createFuzzer();
      const lagging = await testMatchesReducer([
        {
          actions: [
            {kind: 'transition', action: {type: 'page', page: 'settings'}},
          ],
        },
        {actions: [{kind: 'transition', action: {type: 'add', by: 3}}]},
        {
          actions: [
            {kind: 'dispatch', action: {type: 'page', page: 'settings'}},
          ],
        },
        {actions: [{kind: 'dispatch', action: {type: 'page', page: 'home'}}]},
      ]);
      expect(lagging).toBe(0);
    });

    // @gate enableStore
    it('a blocking update in the same event as a Transition', async () => {
      const {testMatchesReducer} = createFuzzer();
      const lagging = await testMatchesReducer([
        {actions: [{kind: 'mount', mounted: true}]},
        {
          actions: [
            {kind: 'transitionMount', mounted: false},
            {kind: 'transition', action: {type: 'page', page: 'about'}},
            {kind: 'dispatch', action: {type: 'add', by: 1}},
          ],
        },
      ]);
      expect(lagging).toBe(0);
    });

    // @gate enableStore
    it('a Transition that changes nothing still entangles', async () => {
      const {testMatchesReducer} = createFuzzer();
      const lagging = await testMatchesReducer([
        {
          actions: [
            {kind: 'transition', action: {type: 'page', page: 'profile'}},
          ],
        },
        {
          actions: [
            {kind: 'transition', action: {type: 'filter', filter: 'all'}},
            {kind: 'transitionMount', mounted: true},
          ],
        },
      ]);
      expect(lagging).toBe(0);
    });

    // @gate enableStore
    it('a Transition no reader renders', async () => {
      const {testMatchesReducer} = createFuzzer();
      const lagging = await testMatchesReducer([
        {
          actions: [
            {kind: 'transition', action: {type: 'filter', filter: 'open'}},
          ],
        },
        {
          actions: [
            {kind: 'transition', action: {type: 'page', page: 'about'}},
          ],
        },
        {actions: [{kind: 'transitionMount', mounted: true}]},
      ]);
      expect(lagging).toBe(0);
    });
  });

  // @gate enableStore
  it(`generative tests (random seed: ${SEED})`, async () => {
    const {generateSteps, testMatchesReducer} = createFuzzer();
    const rand = Random.create(SEED);

    // If this is too large the test will time out.
    const NUMBER_OF_TEST_CASES = 100;
    const STEPS_PER_CASE = 16;

    let lagging = 0;
    for (let i = 0; i < NUMBER_OF_TEST_CASES; i++) {
      const steps = generateSteps(rand, STEPS_PER_CASE);
      try {
        lagging += await testMatchesReducer(steps);
      } catch (e) {
        console.log(`
Failed fuzzy test case:

${JSON.stringify(steps, null, 2)}

Random seed is ${SEED}
`);
        throw e;
      }
    }
    // Waiting on a Transition useReducer does not is rare, not the rule.
    expect(lagging).toBeLessThan(
      (NUMBER_OF_TEST_CASES * (STEPS_PER_CASE + 1)) / 20,
    );
  });
});
