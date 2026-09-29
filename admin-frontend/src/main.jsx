import React from 'react';
import ReactDOM from 'react-dom/client';
// import { BrowserRouter } from 'react-router-dom';
import { HashRouter } from 'react-router-dom'; // 👈 Changed from BrowserRouter
import App from './App.jsx';
import { AdminAuthProvider } from './contexts/AdminAuthContext.jsx';
import './styles/index.css';

// ReactDOM.createRoot(document.getElementById('root')).render(
//   <React.StrictMode>
//     <BrowserRouter>
//       <AdminAuthProvider>
//         <App />
//       </AdminAuthProvider>
//     </BrowserRouter>
//   </React.StrictMode>
// );
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <HashRouter> {/* 👈 Changed from BrowserRouter */}
      <AdminAuthProvider>
        <App />
      </AdminAuthProvider>
    </HashRouter>
  </React.StrictMode>
);