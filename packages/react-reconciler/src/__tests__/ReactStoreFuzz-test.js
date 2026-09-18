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
let act;
let Random;

const SEED = process.env.FUZZ_TEST_SEED || 'default';

describe('ReactStoreFuzz', () => {
  function resetModules() {
    jest.resetModules();
    React = require('react');
    ReactNoop = require('react-noop-renderer');
    act = require('internal-test-utils').act;
  }

  beforeEach(() => {
    resetModules();
    Random = require('random-seed');
  });

  jest.setTimeout(20000);

  // Randomized actions checked against the rules a store follows. A store's
  // state behaves like state that lives above each root and is read through
  // context, so React's rules for Transitions and Suspense decide what a root
  // may commit:
  //
  // 1. A commit shows one state: every reader shows the same state, and the
  //    root's own state is from the same moment.
  // 2. That state includes every blocking action from earlier events, and the
  //    pending Transitions of each queue in the order they were dispatched,
  //    because updates to one queue entangle. Updates that share a lane, from
  //    the same event or the same async Action, commit together.
  // 3. An async Action's updates commit once the Action finishes.
  // 4. A root never goes back to an earlier state.
  // 5. A Transition does not replace visible content with a fallback.
  // 6. Once every Action finishes and all data loads, the root shows the
  //    latest state.
  //
  // The same rules are checked against React state that lives above the tree,
  // which follows them by definition.
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

    const ROOTS = 2;
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
      const selections = {
        page: store.select(state => state.page),
        count: store.select(state => state.count),
        filter: store.select(state => state.filter),
      };
      function StorePage() {
        return <Page page={React.use(selections.page)} />;
      }
      function StoreCount() {
        return <Count count={React.use(selections.count)} />;
      }
      function StoreFilter() {
        return <Filter filter={React.use(selections.filter)} />;
      }
      const app = {dispatch: store.dispatch, setExtraMounted: [], App: null};
      app.App = function StoreApp({index}) {
        const [extraMounted, setExtraMounted] = React.useState(false);
        app.setExtraMounted[index] = setExtraMounted;
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

    // The same app with its state in React, above the tree of each root. An
    // action is dispatched to every root in the same event.
    function createStateApp() {
      const dispatchers = [];
      const app = {
        dispatch: action => {
          for (let i = 0; i < dispatchers.length; i++) {
            dispatchers[i](action);
          }
        },
        setExtraMounted: [],
        App: null,
      };
      app.App = function StateApp({index}) {
        const [extraMounted, setExtraMounted] = React.useState(false);
        const [state, dispatch] = React.useReducer(reducer, initialState);
        app.setExtraMounted[index] = setExtraMounted;
        dispatchers[index] = dispatch;
        return (
          <>
            <React.Suspense fallback="loading ">
              <Page page={state.page} />
            </React.Suspense>
            <Count count={state.count} />
            {extraMounted ? <Filter filter={state.filter} /> : null}
          </>
        );
      };
      return app;
    }

    // Runs the steps in two roots, then finishes every Action and loads all
    // data. Returns the output of every commit, with its root and step.
    async function run(createApp, steps) {
      // Lanes are assigned in a cycle, and React entangles them differently
      // depending on where in it they are, so every app starts at the same place.
      resetModules();
      const app = createApp();
      textCache = new Map();
      let finishActions = [];
      const commits = [];
      let step = -1;
      const roots = [];
      for (let index = 0; index < ROOTS; index++) {
        const root = ReactNoop.createRoot();
        roots.push(root);
        const onRender = () => {
          commits.push({root: index, step, output: root.getChildrenAsJSX()});
        };
        await act(() =>
          root.render(
            <React.Profiler id="root" onRender={onRender}>
              <app.App index={index} />
            </React.Profiler>,
          ),
        );
      }
      const allSteps = withFinalStep(steps);
      for (step = 0; step < allSteps.length; step++) {
        await act(() => {
          const actions = allSteps[step].actions;
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
                app.setExtraMounted[action.root || 0](action.mounted);
                break;
              case 'transitionMount':
                React.startTransition(() =>
                  app.setExtraMounted[action.root || 0](action.mounted),
                );
                break;
              case 'asyncTransition':
                React.startTransition(async () => {
                  app.dispatch(action.action);
                  await new Promise(resolve => finishActions.push(resolve));
                });
                break;
              case 'finishActions': {
                const pending = finishActions;
                finishActions = [];
                pending.forEach(resolve => resolve());
                break;
              }
            }
          }
        });
      }
      return commits;
    }

    function withFinalStep(steps) {
      return steps.concat([
        {
          actions: [{kind: 'finishActions'}].concat(
            PAGES.map(text => ({kind: 'resolve', text})),
          ),
        },
      ]);
    }

    // Every update the steps make, with the lane group it is in. A blocking
    // update's group is its event. A Transition's group is its event's lane:
    // the pending async Action's lane, or the next of React's ten Transition
    // lanes. An update that changes nothing may bail out without being queued,
    // so it may not be in its group.
    function describeUpdates(steps, root) {
      const updates = [];
      let latestState = initialState;
      let latestMounted = false;
      const actionFinishedIn = new Map();
      // Lanes claimed again, while their earlier group may still be pending.
      const reusedLanes = [];
      const laneClaims = new Map();
      let nextLane = 0;
      let pendingAction = null;
      let unfinished = 0;
      for (let i = 0; i < steps.length; i++) {
        const actions = steps[i].actions;
        let group = null;
        const transitionGroup = () => {
          if (group === null) {
            if (pendingAction !== null) {
              group = pendingAction;
            } else {
              const lane = nextLane;
              nextLane = (nextLane + 1) % 10;
              const claim = laneClaims.has(lane) ? laneClaims.get(lane) + 1 : 0;
              laneClaims.set(lane, claim);
              group = 'lane' + lane + '#' + claim;
              if (claim > 0) {
                reusedLanes.push({
                  group,
                  earlierGroup: 'lane' + lane + '#' + (claim - 1),
                });
              }
              if (actions.some(a => a.kind === 'asyncTransition')) {
                pendingAction = group;
              }
            }
          }
          return group;
        };
        for (let j = 0; j < actions.length; j++) {
          const a = actions[j];
          switch (a.kind) {
            case 'dispatch':
            case 'transition':
            case 'asyncTransition': {
              const isBlocking = a.kind === 'dispatch';
              const nextState = reducer(latestState, a.action);
              updates.push({
                step: i,
                queue: 'store',
                group: isBlocking ? 'event' + i : transitionGroup(),
                isBlocking,
                isNoop: nextState === latestState,
                action: a.action,
              });
              latestState = nextState;
              if (a.kind === 'asyncTransition') {
                unfinished++;
              }
              break;
            }
            case 'mount':
            case 'transitionMount': {
              const isBlocking = a.kind === 'mount';
              if ((a.root || 0) !== root) {
                // Another root's update still claims the event's lane.
                if (!isBlocking) {
                  transitionGroup();
                }
                break;
              }
              updates.push({
                step: i,
                queue: 'app',
                group: isBlocking ? 'event' + i : transitionGroup(),
                isBlocking,
                isNoop: a.mounted === latestMounted,
                mounted: a.mounted,
              });
              latestMounted = a.mounted;
              break;
            }
            case 'finishActions':
              unfinished = 0;
              break;
          }
        }
        // An Action finishes after the event that resolves it.
        if (pendingAction !== null && unfinished === 0) {
          actionFinishedIn.set(pendingAction, i);
          pendingAction = null;
        }
      }
      return {updates, actionFinishedIn, reusedLanes};
    }

    // Updates in a reused lane join the earlier group if it is still pending.
    // `merged` has a bit for each reused lane that does.
    function mergeReusedLanes(
      {updates, actionFinishedIn, reusedLanes},
      merged,
    ) {
      const groups = new Map();
      const resolve = group => (groups.has(group) ? groups.get(group) : group);
      const finishedIn = new Map(actionFinishedIn);
      for (let i = 0; i < reusedLanes.length; i++) {
        if ((merged & (1 << i)) !== 0) {
          const {group, earlierGroup} = reusedLanes[i];
          const into = resolve(earlierGroup);
          groups.set(group, into);
          if (finishedIn.has(group)) {
            finishedIn.set(
              into,
              Math.max(finishedIn.get(group), finishedIn.get(into) ?? -1),
            );
          }
        }
      }
      return {
        updates: updates.map(update =>
          update.isBlocking
            ? update
            : {...update, group: resolve(update.group)},
        ),
        actionFinishedIn: finishedIn,
      };
    }

    function transitionGroups(updates, queue, step) {
      const groups = [];
      for (let i = 0; i < updates.length; i++) {
        const update = updates[i];
        if (
          update.queue === queue &&
          !update.isBlocking &&
          update.step <= step &&
          !groups.includes(update.group)
        ) {
          groups.push(update.group);
        }
      }
      return groups;
    }

    // What a queue shows with the blocking updates up to `blockingStep` and
    // the Transitions in `committed`.
    function reduceQueue(updates, queue, step, blockingStep, committed) {
      let value = queue === 'store' ? initialState : false;
      for (let i = 0; i < updates.length; i++) {
        const update = updates[i];
        if (
          update.queue === queue &&
          update.step <= step &&
          (update.isBlocking
            ? update.step <= blockingStep
            : committed.has(update.group))
        ) {
          value =
            queue === 'store' ? reducer(value, update.action) : update.mounted;
        }
      }
      return value;
    }

    // The states a commit in `step` may show: blocking updates up to the
    // previous event, or this one, and a prefix of each queue's Transitions.
    // Updates from the same event share a lane, so they commit together. An
    // async Action's updates to a queue wait for the Action to finish, unless
    // they do not change what the queue shows.
    function allowedStates(updates, actionFinishedIn, step) {
      const storeGroups = transitionGroups(updates, 'store', step);
      const appGroups = transitionGroups(updates, 'app', step);
      const allowed = [];
      for (let blockingStep = step - 1; blockingStep <= step; blockingStep++) {
        for (let s = 0; s <= storeGroups.length; s++) {
          for (let a = 0; a <= appGroups.length; a++) {
            const committed = {
              store: new Set(storeGroups.slice(0, s)),
              app: new Set(appGroups.slice(0, a)),
            };
            const isSameLaneCommitted = updates.every(
              update =>
                update.isBlocking ||
                update.isNoop ||
                update.step > step ||
                updates.every(
                  other =>
                    other.queue === update.queue ||
                    other.step !== update.step ||
                    other.group !== update.group ||
                    other.isNoop ||
                    committed.store.has(update.group) ===
                      committed.app.has(update.group),
                ),
            );
            if (!isSameLaneCommitted) {
              continue;
            }
            const state = reduceQueue(
              updates,
              'store',
              step,
              blockingStep,
              committed.store,
            );
            const mounted = reduceQueue(
              updates,
              'app',
              step,
              blockingStep,
              committed.app,
            );
            const isActionWaitedFor = ['store', 'app'].every(queue =>
              Array.from(committed[queue]).every(group => {
                if (
                  !actionFinishedIn.has(group) ||
                  actionFinishedIn.get(group) <= step
                ) {
                  return true;
                }
                const without = new Set(committed[queue]);
                without.delete(group);
                const value = queue === 'store' ? state : mounted;
                return (
                  JSON.stringify(
                    reduceQueue(updates, queue, step, blockingStep, without),
                  ) === JSON.stringify(value)
                );
              }),
            );
            if (isActionWaitedFor) {
              allowed.push({position: [blockingStep, s, a], state, mounted});
            }
          }
        }
      }
      return allowed;
    }

    function shows(output, {state, mounted}) {
      const [page, count, filter] = output.trim().split(' ');
      return (
        (page === 'loading' || page === 'page:' + state.page) &&
        count === 'count:' + state.count &&
        filter === (mounted ? 'filter:' + state.filter : undefined)
      );
    }

    function checkRules(steps, allCommits) {
      for (let root = 0; root < ROOTS; root++) {
        const commits = allCommits.filter(commit => commit.root === root);
        const error = checkRootRules(steps, commits, root);
        if (error !== null) {
          return `Root ${root}: ${error}`;
        }
      }
      return null;
    }

    // Each root follows the rules on its own.
    function checkRootRules(steps, commits, root) {
      const described = describeUpdates(withFinalStep(steps), root);
      let error = null;
      for (
        let merged = 0;
        merged < 1 << described.reusedLanes.length;
        merged++
      ) {
        const {updates, actionFinishedIn} = mergeReusedLanes(described, merged);
        const result = checkCommits(steps, commits, updates, actionFinishedIn);
        if (result === null) {
          return null;
        }
        if (error === null) {
          error = result;
        }
      }
      return error;
    }

    function checkCommits(steps, commits, updates, actionFinishedIn) {
      // Positions the root may be at after each commit, never going back.
      let positions = [[-1, 0, 0]];
      for (let c = 0; c < commits.length; c++) {
        const {step, output} = commits[c];
        const next = allowedStates(updates, actionFinishedIn, step)
          .filter(candidate => shows(output, candidate))
          .map(candidate => candidate.position)
          .filter(position =>
            positions.some(previous =>
              previous.every((value, i) => value <= position[i]),
            ),
          );
        if (next.length === 0) {
          return `Commit ${c} in step ${step} shows ${output}, which is not a state the root may show`;
        }
        positions = next;
        if (c > 0) {
          const previous = commits[c - 1].output;
          if (
            output.startsWith('loading') &&
            !previous.startsWith('loading') &&
            !updates.some(
              update =>
                update.step === step &&
                update.isBlocking &&
                update.queue === 'store' &&
                update.action.type === 'page',
            )
          ) {
            return `Commit ${c} in step ${step} replaces ${previous} with a fallback without a blocking update`;
          }
        }
      }
      const last = commits[commits.length - 1];
      const final = allowedStates(
        updates,
        actionFinishedIn,
        steps.length,
      ).filter(candidate => {
        const position = candidate.position;
        return (
          position[0] === steps.length &&
          position[1] ===
            transitionGroups(updates, 'store', steps.length).length &&
          position[2] === transitionGroups(updates, 'app', steps.length).length
        );
      });
      if (!shows(last.output, final[0]) || last.output.startsWith('loading')) {
        return `The last commit shows ${last.output}, not the latest state`;
      }
      return null;
    }

    function describeCommits(steps, commits) {
      return (
        JSON.stringify(steps.map(({actions}) => actions)) +
        '\n\nCommits:\n' +
        commits
          .map(
            ({root, step, output}) => `  root ${root}, step ${step}: ${output}`,
          )
          .join('\n')
      );
    }

    async function testRules(steps) {
      // React state follows the rules, so a failure here is in the rules.
      const stateCommits = await run(createStateApp, steps);
      const stateError = checkRules(steps, stateCommits);
      if (stateError !== null) {
        console.log(
          'React state failed:\n\n' + describeCommits(steps, stateCommits),
        );
        throw new Error(stateError);
      }
      const storeCommits = await run(createStoreApp, steps);
      const storeError = checkRules(steps, storeCommits);
      if (storeError !== null) {
        console.log(
          'Failed fuzzy test case:\n\n' + describeCommits(steps, storeCommits),
        );
        throw new Error(storeError);
      }
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
        switch (rand(8)) {
          case 0:
            return {kind: 'dispatch', action: randomAction()};
          case 1:
          case 2:
            return {kind: 'transition', action: randomAction()};
          case 3:
            return {kind: 'resolve', text: PAGES[1 + rand(PAGES.length - 1)]};
          case 4:
            return {kind: 'mount', mounted: rand(2) === 0, root: rand(ROOTS)};
          case 5:
            return {
              kind: 'transitionMount',
              mounted: rand(2) === 0,
              root: rand(ROOTS),
            };
          case 6:
            return {kind: 'asyncTransition', action: randomAction()};
          default:
            return {kind: 'finishActions'};
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

    return {testRules, generateSteps};
  }

  describe('hard-coded cases', () => {
    // @gate enableStore && enableProfilerTimer
    it('a blocking update while a Transition waits on data', async () => {
      const {testRules} = createFuzzer();
      await testRules([
        {
          actions: [
            {kind: 'transition', action: {type: 'page', page: 'about'}},
          ],
        },
        {actions: [{kind: 'dispatch', action: {type: 'add', by: 1}}]},
        {actions: [{kind: 'mount', mounted: true}]},
        {actions: [{kind: 'resolve', text: 'about'}]},
      ]);
    });

    // @gate enableStore && enableProfilerTimer
    it('a reader hidden by a fallback hears the update that reveals it', async () => {
      const {testRules} = createFuzzer();
      await testRules([
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
    });

    // @gate enableStore && enableProfilerTimer
    it('a blocking update in the same event as a Transition', async () => {
      const {testRules} = createFuzzer();
      await testRules([
        {actions: [{kind: 'mount', mounted: true}]},
        {
          actions: [
            {kind: 'transitionMount', mounted: false},
            {kind: 'transition', action: {type: 'page', page: 'about'}},
            {kind: 'dispatch', action: {type: 'add', by: 1}},
          ],
        },
      ]);
    });

    // @gate enableStore && enableProfilerTimer
    it('a Transition that changes nothing still entangles', async () => {
      const {testRules} = createFuzzer();
      await testRules([
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
    });

    // @gate enableStore && enableProfilerTimer
    it('an update inside an async Action waits for the Action', async () => {
      const {testRules} = createFuzzer();
      await testRules([
        {actions: [{kind: 'asyncTransition', action: {type: 'add', by: 2}}]},
        {actions: [{kind: 'dispatch', action: {type: 'add', by: 1}}]},
        {actions: [{kind: 'finishActions'}]},
      ]);
    });

    // @gate enableStore && enableProfilerTimer
    it('a Transition no reader renders', async () => {
      const {testRules} = createFuzzer();
      await testRules([
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
    });
  });

  // @gate enableStore && enableProfilerTimer
  it(`generative tests (random seed: ${SEED})`, async () => {
    const {generateSteps, testRules} = createFuzzer();
    const rand = Random.create(SEED);

    // If this is too large the test will time out.
    const NUMBER_OF_TEST_CASES = 100;
    const STEPS_PER_CASE = 16;

    for (let i = 0; i < NUMBER_OF_TEST_CASES; i++) {
      await testRules(generateSteps(rand, STEPS_PER_CASE));
    }
  });
});
