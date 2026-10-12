import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Routes, Route } from "react-router-dom";

import { GlobalState } from './State.jsx';
import WebsocketManager from './services/WebSocket.jsx';

import TopBar from './components/TopBar.jsx';
import LeftBar from './components/LeftBar.jsx';
import Footer from './components/Footer.jsx';
import IntroAnimation from './components/IntroAnimation.jsx';

import Home from './pages/Home.jsx';
import Dataset from './pages/Dataset.jsx';



function App() {
  const { headerCollapsed } = GlobalState();
  const [mouseIdle, setMouseIdle] = useState(false);
  const [introComplete, setIntroComplete] = useState(() => {
    return sessionStorage.getItem('dv_intro_played') === '1';
  });
  const [contentRevealed, setContentRevealed] = useState(() => {
    return sessionStorage.getItem('dv_intro_played') === '1';
  });
  const idleTimer = useRef(null);

  const handleIntroComplete = useCallback(() => {
    sessionStorage.setItem('dv_intro_played', '1');
    setIntroComplete(true);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setContentRevealed(true));
    });
  }, []);

  useEffect(() => {
    const resetIdle = () => {
      setMouseIdle(false);
      clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => setMouseIdle(true), 3000);
    };
    window.addEventListener('mousemove', resetIdle);
    idleTimer.current = setTimeout(() => setMouseIdle(true), 3000);
    return () => {
      window.removeEventListener('mousemove', resetIdle);
      clearTimeout(idleTimer.current);
    };
  }, []);

  return (
    <div className={`app-root${headerCollapsed ? ' header-collapsed' : ''}${mouseIdle ? ' mouse-idle' : ''}`} style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <WebsocketManager />
      {!introComplete && <IntroAnimation onComplete={handleIntroComplete} />}
      <TopBar />
      <LeftBar />
      
      <div className={`app-content--A ${contentRevealed ? 'revealed' : ''}`} style={{ flex: 1 }}>
        <Routes>
          <Route path='/' element={<Home />} />
          <Route path='/dataset' element={<Dataset />} />
        </Routes>  
      </div>
      
      <Footer />
    </div>
  );
}

export default App;
