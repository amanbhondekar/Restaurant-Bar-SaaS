import React from 'react';
import ReactDOM from 'react-dom/client';
import { DinerMenu } from './diner/DinerMenu';
import './diner/diner.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <DinerMenu />
  </React.StrictMode>
);
