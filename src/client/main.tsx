import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import { ExternalRoomAccessPage } from "./rooms/ExternalRoomAccessPage";
import "./ui/styles.css";

const shareMatch = location.pathname.match(/^\/share\/([A-Za-z0-9_-]{32,})\/?$/);
createRoot(document.getElementById("root")!).render(<React.StrictMode>{shareMatch ? <ExternalRoomAccessPage token={shareMatch[1]} /> : <App />}</React.StrictMode>);
