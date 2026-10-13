import { createContext, useContext, type ReactNode } from "react";
import { useLive, type LiveData } from "../lib/api";

interface LiveContextValue {
  /** Latest message from the backend (sensors, alarm, stage, purification), or null. */
  live: LiveData | null;
  /** True while the backend is connected and sending data. */
  backend: boolean;
  /** True when the backend runs its simulated machine (demo mode), or when there's no backend. */
  mock: boolean;
  /** True for the first moment after the page opens, before the connection is known. */
  connecting: boolean;
}

const LiveContext = createContext<LiveContextValue>({ live: null, backend: false, mock: true, connecting: false });

export function useLiveData() {
  return useContext(LiveContext);
}

/** One shared connection to the backend's live data for the whole website. */
export function LiveProvider({ children }: { children: ReactNode }) {
  const { live, connected, checked } = useLive();
  const current = connected ? live : null;
  return (
    <LiveContext.Provider value={{ live: current, backend: current !== null, mock: current ? current.mock : true, connecting: !checked }}>
      {children}
    </LiveContext.Provider>
  );
}
