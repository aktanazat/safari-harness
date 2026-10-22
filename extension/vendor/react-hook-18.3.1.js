/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * Licensed under the MIT license in react-hook-LICENSE.
 * Derived from React v18.3.1, packages/react-devtools-shared/src/hook.js:
 * https://github.com/facebook/react/blob/v18.3.1/packages/react-devtools-shared/src/hook.js
 * Changes: retain only renderer registration, root tracking and the event API;
 * omit console patching, profiling, renderer backends and component execution;
 * add explicit disposal and bounded renderer/root/subscriber retention.
 * Loading this file does not install a React hook.
 */
(() => {
  if (Object.hasOwn(window, "__safariHarnessCreateReactHook")) return;
  Object.defineProperty(window, "__safariHarnessCreateReactHook", {
    configurable: true,
    value: () => {
      let active = true;
      let uidCounter = 0;
      const renderers = new Map();
      const fiberRoots = new Map();
      const listeners = new Map();
      const limits = { renderers: false, roots: false, listeners: false };
      const on = (event, fn) => {
        if (!active || typeof event !== "string" || typeof fn !== "function") return;
        if (!listeners.has(event) && listeners.size >= 16) { limits.listeners = true; return; }
        const group = listeners.get(event) ?? [];
        if (group.length >= 32) { limits.listeners = true; return; }
        group.push(fn);
        listeners.set(event, group);
      };
      const off = (event, fn) => {
        const group = listeners.get(event);
        if (!group) return;
        const index = group.indexOf(fn);
        if (index !== -1) group.splice(index, 1);
        if (!group.length) listeners.delete(event);
      };
      const emit = (event, data) => {
        if (!active) return;
        for (const fn of [...(listeners.get(event) ?? [])]) {
          try { fn(data); } catch { off(event, fn); }
        }
      };
      const getFiberRoots = (rendererID) => {
        if (!active || !renderers.has(rendererID)) return new Set();
        if (!fiberRoots.has(rendererID)) fiberRoots.set(rendererID, new Set());
        return fiberRoots.get(rendererID);
      };
      const hook = {
        renderers,
        supportsFiber: true,
        isDisabled: false,
        on, off, emit,
        sub(event, fn) { on(event, fn); return () => off(event, fn); },
        inject(renderer) {
          const id = ++uidCounter;
          if (!active) return id;
          if (renderers.size >= 32) { limits.renderers = true; return id; }
          renderers.set(id, renderer);
          emit("renderer", { id, renderer, reactBuildType: renderer.bundleType > 0 ? "development" : "production" });
          return id;
        },
        getFiberRoots,
        onCommitFiberRoot(rendererID, root) {
          if (!active || !renderers.has(rendererID) || !root?.current) return;
          const mountedRoots = getFiberRoots(rendererID);
          const isKnownRoot = mountedRoots.has(root);
          const current = root.current;
          const isUnmounting = current.memoizedState == null || current.memoizedState.element == null;
          if (!isKnownRoot && !isUnmounting) {
            if (mountedRoots.size < 32) mountedRoots.add(root);
            else limits.roots = true;
          } else if (isKnownRoot && isUnmounting) mountedRoots.delete(root);
          emit("commitFiberRoot", { rendererID, root });
        },
        onCommitFiberUnmount(rendererID, fiber) { emit("commitFiberUnmount", { rendererID, fiber }); },
      };
      return {
        hook,
        limits,
        disable() {
          active = false;
          hook.isDisabled = true;
          for (const roots of fiberRoots.values()) roots.clear();
          fiberRoots.clear();
          renderers.clear();
          listeners.clear();
        },
      };
    },
  });
})();
