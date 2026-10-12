import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'

import { State } from './State.jsx'
import App from './App.jsx'

import './GlobalStyles.css'


ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <State>    
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </State>
  </React.StrictMode>,
)
