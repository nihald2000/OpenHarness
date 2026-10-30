export function useState(init) {
  const val = typeof init === "function" ? init() : init;
  return [val, () => {}];
}
export function useEffect() {}
export function useCallback(fn) {
  return fn;
}
export function useMemo(fn) {
  return fn();
}
export function useRef(val) {
  return { current: val };
}
export function createContext(defaultVal) {
  return { Provider: () => null, _currentValue: defaultVal };
}
export function useContext(ctx) {
  return ctx?._currentValue;
}
export default {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  createContext,
  useContext,
};
