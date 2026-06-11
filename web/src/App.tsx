import { useEffect } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { startViewerStateStream } from "./lib/state";
import { hydrateFromServer } from "./lib/prefs";
import { UrlSyncBridge } from "./lib/url";
import Layout from "./components/Layout";

export default function App() {
  useEffect(() => {
    startViewerStateStream();
    hydrateFromServer();
  }, []);
  return (
    <>
      <UrlSyncBridge />
      <Routes>
        <Route path="/" element={<Layout />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
