import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { KubeObject } from '../lib/k8s/KubeObject';

interface DrawerModeState {
  isDetailDrawerEnabled: boolean;
  selectedResource: KubeObject | undefined;
}

const getLocalDrawerStatus = (key: string) => {
  const local = localStorage.getItem(key);
  if (local === null) return false;
  return local === 'true';
};

const initialState: DrawerModeState = {
  isDetailDrawerEnabled: getLocalDrawerStatus('detailDrawerEnabled'),
  selectedResource: undefined,
};

const drawerModeSlice = createSlice({
  name: 'drawerMode',
  initialState,
  reducers: {
    setDetailDrawerEnabled: (state, action: PayloadAction<boolean>) => {
      state.isDetailDrawerEnabled = action.payload;
      localStorage.setItem('detailDrawerEnabled', `${action.payload}`);
    },
    // todo
    setSelectedResource: (state, action: any) => {
      state.selectedResource = action.payload;
    },
  },
});

export const { setDetailDrawerEnabled, setSelectedResource } = drawerModeSlice.actions;
export default drawerModeSlice.reducer;
