// The side panel: its state in a Zustand store, so a React view can subscribe to what it draws while
// the panel's code keeps reading and writing `state` (core.js) as a plain object.
// One part of the panel; sidepanel.js wires the parts together.
import { createStore } from 'zustand/vanilla';

// The panel's state. A React view reads it with a selector (useStore(panelStore, (s) => s.filter))
// and redraws when that changes.
const panelStore = createStore(() => ({}));

// `state` as the panel's code uses it: reading a field reads the store's, and assigning one sets it in
// the store, which tells the views subscribed (assigning the value it already has tells no one).
// A change made in place, such as a Map's set, a push to an array or a field of `state.fillingFor`,
// is not an assignment to `state` and tells no one: a view that draws it needs that change made as
// an assignment of a new value.
function storeState(initial) {
  panelStore.setState(initial, true);
  const now = () => panelStore.getState();
  return new Proxy({}, {
    get: (_, key) => now()[key],
    set: (_, key, value) => {
      if (!Object.hasOwn(now(), key) || !Object.is(now()[key], value)) panelStore.setState({ [key]: value });
      return true;
    },
    has: (_, key) => key in now(),
    deleteProperty: (_, key) => {
      if (!(key in now())) return true;
      const next = { ...now() };
      delete next[key];
      panelStore.setState(next, true);
      return true;
    },
    ownKeys: () => Reflect.ownKeys(now()),
    getOwnPropertyDescriptor: (_, key) => (key in now() ? { value: now()[key], writable: true, enumerable: true, configurable: true } : undefined),
  });
}

export { panelStore, storeState };
