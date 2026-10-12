import React, { useState, useEffect } from 'react';
import { BrandMark } from './Utils.jsx';
import './IntroAnimation.css';


function IntroAnimation({ onComplete }) {

  const [phase, setPhase] = useState('closed');

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase('brand'),    300),
      setTimeout(() => setPhase('presents'), 1300),
      setTimeout(() => setPhase('title'),    2500),
      setTimeout(() => setPhase('opening'),  3900),
      setTimeout(() => setPhase('fading'),   5000),
      setTimeout(() => { setPhase('done'); onComplete(); }, 6100),
    ];
    return () => timers.forEach(clearTimeout);
  }, [onComplete]);

  if (phase === 'done') return null;

  const isAfterBrand    = phase === 'brand' || phase === 'presents';
  const isAfterTitle    = phase === 'title' || phase === 'opening' || phase === 'fading';
  const isFadingOut     = phase === 'title';
  const isRevealing     = phase === 'fading';

  return (
    <div className={`intro-overlay--IA ${isRevealing ? 'fading' : ''}`} onClick={() => { setPhase('done'); onComplete(); }}>

      {/* ── Upper door (becomes the top bar) ── */}
      <div className={`intro-upper-door--IA ${phase} ${isRevealing ? 'fading' : ''}`}>
        <div className="intro-shine--IA intro-shine-upper--IA" />

        {/* ── Brand + tagline (centered, fades out before title) ── */}
        <div className={`intro-presents-block--IA ${isAfterBrand ? 'visible' : ''} ${isFadingOut ? 'fade-out' : ''}`}>
          <BrandMark size={72} className="intro-presents-logo--IA" />
          <span className={`intro-presents-text--IA ${phase === 'presents' ? 'visible' : ''}`}>
            load · explore · test
          </span>
        </div>

        {/* ── Claude Trading title (replaces brand block) ── */}
        <div className={`intro-title--IA ${isAfterTitle ? 'visible' : ''}`}>
          <span className="intro-anomaly--IA">Data</span>
          <span className="intro-separator--IA" />
          <span className="intro-sentinel--IA">Viz</span>
        </div>

        {/* ── Logo (materializes top-left during opening) ── */}
        <div className={`intro-suez-logo--IA ${phase === 'opening' || phase === 'fading' ? 'visible' : ''}`}>
          <BrandMark size={46} />
        </div>

        <div className="intro-seam--IA intro-seam-upper--IA" />
      </div>

      {/* ── Lower door ── */}
      <div className={`intro-lower-door--IA ${phase}`}>
        <div className="intro-seam--IA intro-seam-lower--IA" />
        <div className="intro-shine--IA intro-shine-lower--IA" />
      </div>

    </div>
  );
}

export default IntroAnimation;
