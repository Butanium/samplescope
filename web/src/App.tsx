import { useEffect } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { startViewerStateStream } from "./lib/state";
import { hydrateFromServer } from "./lib/prefs";
import { UrlSyncBridge } from "./lib/url";
import Layout from "./components/Layout";

export default function App() {
  useEffect(() => {
    // A tab pinned to one transcript (`pin=`) doesn't follow the shared view, and
    // skipping its event stream is what lets many of them stay open: browsers
    // cap HTTP/1.1 at six connections per host, streams included.
    if (!new URLSearchParams(window.location.search).get("pin")) startViewerStateStream();
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
