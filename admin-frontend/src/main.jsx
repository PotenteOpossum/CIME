import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App.jsx";
import { AdminAuthProvider } from "./contexts/AdminAuthContext.jsx";
import "./styles/index.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <HashRouter>
      <AdminAuthProvider>
        <App />
      </AdminAuthProvider>
    </HashRouter>
  </React.StrictMode>,
);
