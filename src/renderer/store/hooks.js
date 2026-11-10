// @ts-check
import { useDispatch, useSelector, useStore } from 'react-redux';

// Use throughout your app instead of plain `useDispatch` and `useSelector`
export const useAppDispatch = useDispatch;
export const useAppSelector = useSelector;
// For a callback that has to read the state as it is when it runs, not as it
// was at the last render.
export const useAppStore = useStore;
