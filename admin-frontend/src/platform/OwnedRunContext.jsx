import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { useAdminAuth } from "../contexts/AdminAuthContext.jsx";
import { runId } from "./context.js";
import { platformRequest } from "./platformApi.js";

const OwnedRunContext = createContext(null);
export const useOwnedRun = () => useContext(OwnedRunContext);
export function OwnedRunProvider({ children }) {
  const { token } = useAdminAuth();
  const [run, setRun] = useState(null);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    const data = await platformRequest(`/platform/runs/${runId}`, token);
    setRun(data.run);
    setError("");
    return data.run;
  }, [token]);
  useEffect(() => {
    let live = true;
    refresh().catch((e) => {
      if (live) setError(e.message);
    });
    return () => {
      live = false;
    };
  }, [refresh]);
  return (
    <OwnedRunContext.Provider value={{ run, error, refresh }}>
      {children}
    </OwnedRunContext.Provider>
  );
}
