/**
 * Whether a Transition started later can join one that is already pending.
 *
 * An external store needs this. A component that mounts while a Transition is
 * pending should arrive with its siblings when that Transition commits, but an
 * update scheduled from a later event claims a fresh lane and commits on its
 * own. Async Actions already join: updates made while an Action's promise is
 * pending reuse its lane. These tests pin both, as a baseline for a primitive
 * that extends the second behaviour to a Transition pending on data.
 */

let React;
let ReactNoop;
let Scheduler;
let act;
let assertLog;
let useState;
let startTransition;
let textCache;

describe('ReactJoinTransition', () => {
  beforeEach(() => {
    jest.resetModules();
    React = require('react');
    ReactNoop = require('react-noop-renderer');
    Scheduler = require('scheduler');
    act = require('internal-test-utils').act;
    assertLog = require('internal-test-utils').assertLog;
    useState = React.useState;
    startTransition = React.startTransition;
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
        Scheduler.log(`Suspend! [${text}]`);
        throw record.value;
      }
      return record.value;
    }
    Scheduler.log(`Suspend! [${text}]`);
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

  let setA;
  let setB;
  function App() {
    const [a, _setA] = useState('A0');
    const [b, _setB] = useState('B0');
    setA = _setA;
    setB = _setB;
    return (
      <>
        <React.Suspense fallback={<Text text="loading" />}>
          {a === 'A0' ? <Text text={a} /> : <AsyncText text={a} />}
        </React.Suspense>{' '}
        <Text text={b} />
      </>
    );
  }

  it('a later Transition does not wait for one pending on data', async () => {
    const root = ReactNoop.createRoot();
    await act(() => root.render(<App />));
    assertLog(['A0', 'B0']);

    // Pending: A1 suspends, so the old content stays up.
    await act(() => startTransition(() => setA('A1')));
    assertLog(['Suspend! [A1]', 'loading', 'B0']);
    expect(root).toMatchRenderedOutput('A0 B0');

    // A later event. It claims its own lane: React retries A1 and it still
    // suspends, then commits B1 on its own, then retries A1 on top of B1.
    await act(() => startTransition(() => setB('B1')));
    assertLog([
      'Suspend! [A1]',
      'loading',
      'B0',
      'A0',
      'B1',
      'Suspend! [A1]',
      'loading',
      'B1',
    ]);
    expect(root).toMatchRenderedOutput('A0 B1');

    await act(() => resolveText('A1'));
    assertLog(['A1', 'B1']);
    expect(root).toMatchRenderedOutput('A1 B1');
  });

  it('an update during a pending async Action joins that Action', async () => {
    const root = ReactNoop.createRoot();
    await act(() => root.render(<App />));
    assertLog(['A0', 'B0']);

    let finishAction;
    await act(() =>
      startTransition(async () => {
        setA('A1');
        await new Promise(resolve => (finishAction = resolve));
      }),
    );
    Scheduler.unstable_clearLog();
    resolveText('A1');
    expect(root).toMatchRenderedOutput('A0 B0');

    // A later event, while the Action's promise is still pending. It reuses
    // the Action's lane, so it waits for the Action rather than committing.
    await act(() => startTransition(() => setB('B1')));
    Scheduler.unstable_clearLog();
    expect(root).toMatchRenderedOutput('A0 B0');

    await act(() => finishAction());
    Scheduler.unstable_clearLog();
    expect(root).toMatchRenderedOutput('A1 B1');
  });
});
