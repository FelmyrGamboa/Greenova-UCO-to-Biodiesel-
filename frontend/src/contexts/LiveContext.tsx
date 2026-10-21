import { createContext, useContext, type ReactNode } from "react";
import { useLive, type LiveData } from "../lib/api";

interface LiveContextValue {
  /** Latest message from the Raspberry Pi (sensors, alarm, stage, pumps, purification), or null. */
  live: LiveData | null;
  /** True while the Raspberry Pi is connected and sending data. The machine can only be run then. */
  backend: boolean;
  /** True for the first moment after the page opens, before the connection is known. */
  connecting: boolean;
}

const LiveContext = createContext<LiveContextValue>({ live: null, backend: false, connecting: false });

export function useLiveData() {
  return useContext(LiveContext);
}

/** One shared connection to the Raspberry Pi's live data for the whole website. */
export function LiveProvider({ children }: { children: ReactNode }) {
  const { live, connected, checked } = useLive();
  const current = connected ? live : null;
  return (
    <LiveContext.Provider value={{ live: current, backend: current !== null, connecting: !checked }}>
      {children}
    </LiveContext.Provider>
  );
}
